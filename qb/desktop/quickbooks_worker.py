"""SmartRepay Windows QuickBooks Desktop worker (Python 3.10+ and pywin32).
Run beside the company file. Environment and recovery instructions: ../SETUP.md.
Only a successful SDK response containing TxnID is acknowledged as posted.
"""
import hashlib
import json
import os
import sqlite3
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from decimal import Decimal
from pathlib import Path


def element(parent, name, value=None):
    node = ET.SubElement(parent, name)
    if value is not None:
        node.text = str(value)
    return node


def reference(parent, name, value):
    element(element(parent, name), 'FullName', value)


def envelope(name, request_id='1'):
    root = ET.Element('QBXML')
    request = element(element(root, 'QBXMLMsgsRq'), name)
    root[0].set('onError', 'stopOnError')
    request.set('requestID', request_id)
    return root, request


def xml_text(root):
    return '<?xml version="1.0" encoding="utf-8"?><?qbxml version="13.0"?>' + ET.tostring(root, encoding='unicode')


def amount(value):
    number = Decimal(str(value))
    if not number.is_finite() or number <= 0 or number != number.quantize(Decimal('.01')):
        raise ValueError('Amounts must be positive with at most two decimal places')
    return f'{number:.2f}'


def posting_request(job):
    p = job['payload']
    if sum(Decimal(amount(line['amount'])) for line in p['lines']) != Decimal(amount(p['amount'])):
        raise ValueError('Unbalanced source lines')
    if p['type'] not in ('emi_receipt', 'payment_disbursed'):
        raise ValueError('Unsupported transaction type')
    deposit = p['type'] == 'emi_receipt'
    root, request = envelope('DepositAddRq' if deposit else 'CheckAddRq', job['id'])
    entry = element(request, 'DepositAdd' if deposit else 'CheckAdd')
    if deposit:
        element(entry, 'TxnDate', p['date'])
        reference(entry, 'DepositToAccountRef', p['bank_account'])
    else:
        reference(entry, 'AccountRef', p['bank_account'])
        reference(entry, 'PayeeEntityRef', p['name'])
        # The complete bank reference is retained in Memo (QB check numbers are short).
        if len(p['reference']) <= 11:
            element(entry, 'RefNumber', p['reference'])
        element(entry, 'TxnDate', p['date'])
    element(entry, 'Memo', f"SmartRepay:{job['id']} Bank reference:{p['reference']}"[:4095])
    for line in p['lines']:
        detail = element(entry, 'DepositLineAdd' if deposit else 'ExpenseLineAdd')
        if deposit:
            reference(detail, 'EntityRef', p['name'])
        reference(detail, 'AccountRef', line['account_name'])
        if deposit:
            element(detail, 'Memo', (line.get('memo') or '')[:4095])
            element(detail, 'Amount', amount(line['amount']))
        else:
            element(detail, 'Amount', amount(line['amount']))
            element(detail, 'Memo', (line.get('memo') or '')[:4095])
    return xml_text(root)


def parse_response(xml, response_name):
    root = ET.fromstring(xml)
    response = root.find('.//' + response_name)
    if response is None:
        raise ValueError('QuickBooks response did not contain ' + response_name)
    return response


def delivery_result(xml, job):
    name = 'Deposit' if job['payload']['type'] == 'emi_receipt' else 'Check'
    response = parse_response(xml, name + 'AddRs')
    external_id = response.findtext('.//' + name + 'Ret/TxnID')
    # Even warning responses can contain an accepted transaction. Never retry these as failures.
    if external_id:
        return {'status': 'posted', 'external_id': external_id}
    if response.get('statusSeverity') == 'Error' and response.get('statusCode') != '0':
        return {'status': 'failed', 'error': response.get('statusMessage', 'QuickBooks rejected the entry')}
    return {'status': 'uncertain', 'error': 'QuickBooks did not return a transaction ID; reconcile before retrying'}


class Worker:
    def __init__(self):
        self.base = os.environ['SMARTREPAY_CONNECTOR_URL'].rstrip('/')
        if not self.base.startswith('https://') and not self.base.startswith(('http://localhost:', 'http://127.0.0.1:')):
            raise ValueError('HTTPS is required except for localhost development')
        self.token = os.environ['QB_DESKTOP_CONNECTOR_TOKEN']
        self.company = os.environ['QB_DESKTOP_COMPANY_NAME']
        self.currency = os.environ.get('QB_DESKTOP_CURRENCY', 'BSD')
        self.company_file = os.environ['QB_COMPANY_FILE']
        if not Path(self.company_file).is_file():
            raise ValueError('QB_COMPANY_FILE must identify the existing .QBW company file')
        journal = Path(os.environ.get('QB_WORKER_JOURNAL', str(Path.home() / '.smartrepay' / 'quickbooks-worker.db')))
        journal.parent.mkdir(parents=True, exist_ok=True)
        # Only one process may use this journal. Keep it across upgrades/restarts.
        import msvcrt
        self.lock_file = open(str(journal) + '.lock', 'a+b')
        self.lock_file.seek(0)
        self.lock_file.write(b'0'); self.lock_file.flush(); self.lock_file.seek(0)
        msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        self.journal = sqlite3.connect(journal)
        self.journal.execute('pragma synchronous=FULL')
        self.journal.execute('create table if not exists deliveries (id text primary key, claim text, payload_hash text, company text, state text, result text, acknowledged integer default 0)')
        self.journal.commit()
        self.rp = None
        self.ticket = None

    def api(self, path, payload):
        request = urllib.request.Request(self.base + path, data=json.dumps(payload).encode(), method='POST', headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def connect(self):
        import win32com.client
        self.rp = win32com.client.Dispatch('QBXMLRP2.RequestProcessor')
        self.rp.OpenConnection2('', 'SmartRepay Desktop Connector', 1)
        self.ticket = self.rp.BeginSession(self.company_file, 2)
        root, _ = envelope('CompanyQueryRq')
        response = parse_response(self.rp.ProcessRequest(self.ticket, xml_text(root)), 'CompanyQueryRs')
        if response.get('statusCode') != '0' or response.findtext('.//CompanyRet/CompanyName') != self.company:
            raise ValueError('QuickBooks company does not match QB_DESKTOP_COMPANY_NAME')

    def inventory(self):
        accounts, iterator_id = [], None
        while True:
            root, request = envelope('AccountQueryRq')
            request.set('iterator', 'Continue' if iterator_id else 'Start')
            if iterator_id:
                request.set('iteratorID', iterator_id)
            element(request, 'MaxReturned', 1000)
            response = parse_response(self.rp.ProcessRequest(self.ticket, xml_text(root)), 'AccountQueryRs')
            if response.get('statusCode') not in ('0', '1'):
                raise ValueError(response.get('statusMessage', 'Account query failed'))
            for a in response.findall('AccountRet'):
                accounts.append({'id': a.findtext('ListID'), 'name': a.findtext('FullName'), 'type': a.findtext('AccountType'), 'active': a.findtext('IsActive') == 'true'})
            if int(response.get('iteratorRemainingCount', '0')) == 0:
                return accounts
            iterator_id = response.get('iteratorID')

    def flush_receipts(self):
        for job_id, claim, result in self.journal.execute('select id,claim,result from deliveries where acknowledged=0 and result is not null').fetchall():
            self.api('/deliveries/' + job_id + '/ack', {**json.loads(result), 'claim_token': claim})
            self.journal.execute('update deliveries set acknowledged=1 where id=?', (job_id,))
            self.journal.commit()

    def process(self, job, accounts):
        if hashlib.sha256(job['payload_json'].encode()).hexdigest() != job['payload_hash'] or json.loads(job['payload_json']) != job['payload']:
            raise ValueError('Delivery integrity check failed')
        if job['company_name'] != self.company or job['payload']['currency'] != self.currency:
            raise ValueError('Unexpected company or currency in delivery')
        previous = self.journal.execute('select claim,payload_hash,state,result from deliveries where id=?', (job['id'],)).fetchone()
        if previous:
            if previous[1] != job['payload_hash']:
                raise ValueError('Delivery payload changed')
            if previous[0] == job['claim_token']:
                return  # Replay acknowledgement from the durable journal, never the SDK write.
            if previous[2] != 'failed':
                raise ValueError('Previously attempted delivery cannot be automatically replayed')
        self.journal.execute('insert or replace into deliveries (id,claim,payload_hash,company,state) values (?,?,?,?,?)', (job['id'],job['claim_token'],job['payload_hash'],self.company,'prepared'))
        self.journal.commit()
        try:
            active = {a['name']: a for a in accounts if a['active']}
            bank = active.get(job['payload']['bank_account'])
            if not bank or bank['type'] != 'Bank':
                raise ValueError('Mapped bank account is missing, inactive, or not a Bank account in QuickBooks')
            for line in job['payload']['lines']:
                if line['account_name'] not in active:
                    raise ValueError('Mapped line account does not exist or is inactive: ' + line['account_name'])
            request = posting_request(job)
        except Exception as error:
            result = {'status': 'failed', 'error': str(error)}
        else:
            # Persist the attempt BEFORE COM. A crash after this point is uncertain, never safe to repeat.
            self.journal.execute("update deliveries set state='sending' where id=?", (job['id'],))
            self.journal.commit()
            try:
                result = delivery_result(self.rp.ProcessRequest(self.ticket, request), job)
            except Exception as error:
                result = {'status': 'uncertain', 'error': 'SDK outcome unknown: ' + str(error)}
        self.journal.execute('update deliveries set state=?,result=?,acknowledged=0 where id=?', (result['status'],json.dumps(result),job['id']))
        self.journal.commit()
        self.flush_receipts()

    def run(self):
        # Recovery from a crash before receipt persistence. Never auto-replay these entries.
        self.journal.execute("update deliveries set state='uncertain', result=? where result is null", (json.dumps({'status':'uncertain','error':'Worker restarted during delivery; inspect company file using the SmartRepay delivery ID in Memo'}),))
        self.journal.commit()
        try:
            self.connect()
            while True:
                try:
                    self.flush_receipts()
                    accounts = self.inventory()
                    self.api('/heartbeat', {'company_name':self.company,'currency':self.currency,'accounts':accounts})
                    job = self.api('/claim', {}).get('delivery')
                    if job:
                        self.process(job, accounts)
                    else:
                        time.sleep(15)
                except (urllib.error.URLError, TimeoutError):
                    print('Server unavailable; receipts retained locally. Retrying in 15 seconds.', flush=True)
                    time.sleep(15)
        finally:
            if self.rp:
                if self.ticket:
                    self.rp.EndSession(self.ticket)
                self.rp.CloseConnection()
            self.journal.close()
            self.lock_file.close()


if __name__ == '__main__':
    if os.name != 'nt':
        raise SystemExit('Run this worker on Windows with QuickBooks Desktop and its SDK installed.')
    Worker().run()
