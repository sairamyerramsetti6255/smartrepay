import hashlib
import json
import sqlite3
import unittest
import urllib.error
import xml.etree.ElementTree as ET
from quickbooks_worker import posting_request, delivery_result, Worker


def job(kind='emi_receipt'):
    p={'type':kind,'date':'2026-09-01','reference':'BANK<&123','bank_account':'Bank & Trust','name':'Wellington Johnson','currency':'BSD','amount':100,'lines':[{'account_name':'Loans Receivable','amount':83,'memo':'Principal'},{'account_name':'Interest Income','amount':17,'memo':'Interest'}]}
    raw=json.dumps(p)
    return {'id':'delivery-1','claim_token':'claim-1','company_name':'Test Company','payload':p,'payload_json':raw,'payload_hash':hashlib.sha256(raw.encode()).hexdigest()}

class WorkerTests(unittest.TestCase):
    def test_deposit_preserves_account_splits_and_escapes_xml(self):
        xml=posting_request(job())
        root=ET.fromstring(xml)
        self.assertEqual(root.findtext('.//DepositToAccountRef/FullName'),'Bank & Trust')
        self.assertEqual([n.text for n in root.findall('.//DepositLineAdd/Amount')],['83.00','17.00'])
        self.assertIn('BANK&lt;&amp;123',xml)

    def test_disbursement_uses_check_and_source_lines(self):
        root=ET.fromstring(posting_request(job('payment_disbursed')))
        self.assertIsNotNone(root.find('.//CheckAdd'))
        self.assertEqual(len(root.findall('.//ExpenseLineAdd')),2)

    def test_unbalanced_amount_fails_before_sdk(self):
        j=job();j['payload']['amount']=101
        with self.assertRaises(ValueError):posting_request(j)

    def test_sdk_success_requires_id_and_warnings_with_id_are_posted(self):
        self.assertEqual(delivery_result('<QBXML><DepositAddRs statusCode="0"><DepositRet><TxnID>QB1</TxnID></DepositRet></DepositAddRs></QBXML>',job())['status'],'posted')
        self.assertEqual(delivery_result('<QBXML><DepositAddRs statusCode="0"/></QBXML>',job())['status'],'uncertain')
        self.assertEqual(delivery_result('<QBXML><DepositAddRs statusCode="1" statusSeverity="Warn"><DepositRet><TxnID>QB1</TxnID></DepositRet></DepositAddRs></QBXML>',job())['status'],'posted')
        self.assertEqual(delivery_result('<QBXML><DepositAddRs statusCode="3100" statusSeverity="Error" statusMessage="Missing account"/></QBXML>',job())['status'],'failed')

    def worker(self):
        w=Worker.__new__(Worker);w.company='Test Company';w.currency='BSD';w.ticket='ticket'
        w.journal=sqlite3.connect(':memory:')
        w.journal.execute('create table deliveries (id text primary key,claim text,payload_hash text,company text,state text,result text,acknowledged integer default 0)')
        class SDK:
            calls=0
            def ProcessRequest(self,*args):
                self.calls+=1
                return '<QBXML><DepositAddRs statusCode="0"><DepositRet><TxnID>QB1</TxnID></DepositRet></DepositAddRs></QBXML>'
        w.rp=SDK()
        return w

    def test_lost_ack_is_replayed_without_duplicate_posting(self):
        w=self.worker()
        def failed(*args):raise urllib.error.URLError('connection lost')
        w.api=failed
        accounts=[{'name':'Bank & Trust','type':'Bank','active':True},{'name':'Loans Receivable','active':True},{'name':'Interest Income','active':True}]
        with self.assertRaises(urllib.error.URLError):w.process(job(),accounts)
        self.assertEqual(w.rp.calls,1)
        results=[];w.api=lambda path,payload:results.append(payload)
        w.flush_receipts();w.process(job(),accounts)
        self.assertEqual(w.rp.calls,1)
        self.assertEqual(results[0]['external_id'],'QB1')
        w.journal.close()

    def test_missing_mapping_is_rejected_without_sdk_write(self):
        w=self.worker();results=[];w.api=lambda path,payload:results.append(payload)
        w.process(job(),[])
        self.assertEqual(w.rp.calls,0);self.assertEqual(results[0]['status'],'failed');w.journal.close()

    def test_corrupt_payload_never_reaches_sdk(self):
        w=self.worker();j=job();j['payload']['amount']=99
        with self.assertRaises(ValueError):w.process(j,[])
        self.assertEqual(w.rp.calls,0);w.journal.close()

if __name__=='__main__':unittest.main()
