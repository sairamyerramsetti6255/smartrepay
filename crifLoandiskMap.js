/**
 * LoanDisk borrower/loan → NodeCRIF row mappers (Subject + Contract).
 * Mirrors db-check/crif-loandisk-lib.js for the online NodeCRIF_* schema.
 */

export const SUBJECT_COLUMNS = [
  'HeaderRT', 'FICode', 'AccountingDate', 'ProductionDate', 'PrograssiveNumber', 'PersonRT',
  'BranchCode', 'FISubjectCode', 'FirstName', 'LastName', 'MiddleName', 'OriginalBirthName',
  'OriginalBirthSurname', 'MotherMaidenSurname', 'Title', 'Gender', 'DateOfBirth', 'PlaceOfBirth',
  'CountryOfCitizenship', 'MaritalStatus', 'NumDependents', 'NIBNumber', 'FieldForFutureUse',
  'AddressStreet', 'AddressCity', 'AddressPOBox', 'AddressDistrict', 'AddressCountry', 'AddressLivedSince',
  'AddAddressStreet', 'AddAddressCity', 'AddAddressPOBox', 'AddAddressDistrict', 'AddAddressCountry',
  'AddAddressLivedSince', 'DocumentType', 'DocumentNumber', 'DocumentIssueDate', 'DocumentIssueCountry',
  'AddDocumentType', 'AddDocumentNumber', 'AddDocumentIssueDate', 'AddDocumentIssueCountry',
  'Landline', 'MobilePhone', 'AdditionalMobile', 'Email', 'SoleTradeName', 'SoleTradeVAT',
  'SoleTradeBRN', 'SoleTradeRegCity', 'SoleTradeEstablishDate', 'SoleTradePhone',
  'EmployerName', 'OccupationStatus', 'EmploymentPhone', 'DateHired', 'DateTerminated',
  'Occupation', 'JobTitle', 'GrossAnnualIncome', 'PrevEmployerName', 'PrevOccupationStatus',
  'PrevEmploymentPhone', 'PrevDateHired', 'PrevDateTerminated', 'PrevOccupation', 'PrevJobTitle',
  'PrevGrossAnnualIncome', 'FooterRT',
]

export const CONTRACT_COLUMNS = [
  'HeaderRT', 'FICode', 'AccountingDate', 'ProductionDate', 'PrograssiveNumber', 'CorrectionFlag',
  'ContractRT', 'BranchCode', 'FISubjectCode', 'FIContractCode', 'ContractType', 'ContractPhase',
  'ContractStatus', 'Currency', 'OriginalCurrency', 'StartDate', 'ContractRequestDate', 'MaturityDate',
  'ContractEndActualDate', 'PaymentMadeDate', 'FlagReorganizedCredit', 'PersonalGuaranteeType',
  'RealGuaranteeType', 'AmountPersonalGuarantee', 'AmountRealGuarantee', 'MaxPaymentsPastDue',
  'MonthsMaxOverdue', 'MaxDaysPastDue', 'WorstStatus', 'DateMaxInsolvency', 'FinancedAmount',
  'NumberOfInstalments', 'PaymentFrequency', 'MethodOfPayment', 'MonthlyInstalmentAmount',
  'NextPaymentDate', 'NextPaymentAmount', 'OutstandingPaymentsNumber', 'OutstandingBalance',
  'NumberPaymentsPastDue', 'AmountPastDue', 'DaysPastDue', 'LeasedGoodType', 'LeasedGoodValue',
  'LeasedGoodNewUsed', 'LeasedGoodBrand', 'LeasedGoodRegistration', 'LeasedGoodManufactureDate',
  'RealDaysPastDue', 'FooterRT',
]

export function pick(row, ...keys) {
  for (const k of keys) {
    if (!k) continue
    const v = row?.[k]
    if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).toLowerCase() !== 'n/a') {
      return String(v).trim()
    }
  }
  return ''
}

function isValidDDMMYYYY8(v) {
  if (!/^\d{8}$/.test(v)) return false
  const dd = Number(v.slice(0, 2))
  const mm = Number(v.slice(2, 4))
  const yyyy = Number(v.slice(4, 8))
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false
  const d = new Date(yyyy, mm - 1, dd)
  return d.getFullYear() === yyyy && d.getMonth() === mm - 1 && d.getDate() === dd
}

export function fmtDDMMYYYY(val) {
  if (!val) return ''
  const s = String(val).trim()
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) {
    const month = Number(m[1])
    const day = Number(m[2])
    return `${String(day).padStart(2, '0')}${String(month).padStart(2, '0')}${m[3]}`
  }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m2) return `${m2[3]}${m2[2]}${m2[1]}`
  const digits = s.replace(/\D/g, '').slice(0, 8)
  if (digits.length === 8 && !isValidDDMMYYYY8(digits)) {
    const swapped = `${digits.slice(2, 4)}${digits.slice(0, 2)}${digits.slice(4)}`
    if (isValidDDMMYYYY8(swapped)) return swapped
  }
  return digits
}

export function lastDayPrevMonthDDMMYYYY() {
  const d = new Date()
  d.setDate(0)
  return fmtDDMMYYYY(`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`)
}

export function todayDDMMYYYY() {
  const d = new Date()
  return fmtDDMMYYYY(`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`)
}

function pickCode(val) {
  if (!val) return ''
  return String(val).split(':')[0].trim()
}

function mapGender(g) {
  if (!g) return ''
  const s = String(g).toUpperCase()
  if (s.startsWith('M') || s === 'MALE') return 'M'
  if (s.startsWith('F') || s === 'FEMALE') return 'F'
  return s.slice(0, 1)
}

function mapDaysPastDueBucket(days) {
  const d = Number(days) || 0
  if (d === 0) return '0'
  if (d <= 30) return '1'
  if (d <= 60) return '2'
  if (d <= 90) return '3'
  if (d <= 180) return '4'
  if (d <= 365) return '5'
  return '6'
}

function mapContractPhase(statusId) {
  const id = Number(statusId)
  if (id === 1 || id === 3) return 'LV'
  if (id === 8) return 'RQ'
  if (id === 9) return 'RF'
  if (id === 17) return 'RN'
  return 'LV'
}

function calcOutstandingPayments(loan) {
  const duration = Number(pick(loan, 'loan_duration', 'loan_num_of_repayments')) || 0
  const totalPaid = Number(pick(loan, 'total_paid')) || 0
  const principal = Number(pick(loan, 'loan_principal_amount')) || 0
  const interest = Number(pick(loan, 'loan_interest_amount')) || 0
  const monthly = duration > 0 ? (principal + interest) / duration : 0
  if (duration <= 0 || monthly <= 0) return '0'
  return String(Math.max(0, duration - Math.floor(totalPaid / monthly)))
}

function calcMonthlyInstalment(loan) {
  const duration = Number(pick(loan, 'loan_duration')) || 0
  const principal = Number(pick(loan, 'loan_principal_amount')) || 0
  const interest = Number(pick(loan, 'loan_interest_amount')) || 0
  if (duration > 0) return ((principal + interest) / duration).toFixed(2)
  return pick(loan, 'amortization', 'custom_field_7783')
}

function addMonthsToDDMMYYYY(ddmmyyyy, months) {
  if (!ddmmyyyy || ddmmyyyy.length !== 8) return ''
  const dt = new Date(Number(ddmmyyyy.slice(4, 8)), Number(ddmmyyyy.slice(2, 4)) - 1, Number(ddmmyyyy.slice(0, 2)))
  dt.setMonth(dt.getMonth() + months)
  return fmtDDMMYYYY(`${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`)
}

export function buildSubjectRow(b, loan, batch, branchId) {
  const row = {}
  for (const col of SUBJECT_COLUMNS) row[col] = ''

  row.HeaderRT = 'H'
  row.PersonRT = 'P'
  row.FooterRT = 'Q'
  row.FICode = pick(b, 'custom_field_6813') || batch.FICode || 'SILML'
  row.AccountingDate = batch.AccountingDate
  row.ProductionDate = batch.ProductionDate
  row.PrograssiveNumber = batch.PrograssiveNumber

  row.BranchCode = pick(b, 'custom_field_7767') || String(branchId)
  row.FISubjectCode = pick(b, 'borrower_id')
  row.FirstName = pick(b, 'borrower_firstname')
  row.LastName = pick(b, 'borrower_lastname')
  row.MiddleName = pick(b, 'custom_field_8198')
  row.OriginalBirthName = pick(b, 'custom_field_8200')
  row.OriginalBirthSurname = pick(b, 'custom_field_8199')
  row.MotherMaidenSurname = pick(b, 'custom_field_8201')
  row.Title = pick(b, 'borrower_title', 'custom_field_8202')
  row.Gender = mapGender(pick(b, 'custom_field_6810', 'borrower_gender'))
  row.DateOfBirth = fmtDDMMYYYY(pick(b, 'custom_field_7764', 'borrower_dob'))
  row.PlaceOfBirth = pick(b, 'custom_field_8203')
  row.CountryOfCitizenship = pick(b, 'custom_field_8204', 'custom_field_6815', 'borrower_country')
  row.MaritalStatus = pickCode(pick(b, 'custom_field_8205'))
  row.NumDependents = pick(b, 'custom_field_8206')
  row.NIBNumber = pick(b, 'custom_field_6822', 'borrower_unique_number')
  row.FieldForFutureUse = ''

  row.AddressStreet = pick(b, 'custom_field_8209', 'borrower_address', 'custom_field_7775')
  row.AddressCity = pick(b, 'custom_field_8210', 'borrower_city', 'custom_field_6823', 'custom_field_7774')
  row.AddressPOBox = pick(b, 'borrower_zipcode')
  row.AddressDistrict = pick(b, 'custom_field_8212', 'borrower_province')
  row.AddressCountry = pick(b, 'custom_field_8213', 'borrower_country', 'custom_field_6815')
  row.AddressLivedSince = fmtDDMMYYYY(pick(b, 'custom_field_8214'))

  row.AddAddressStreet = pick(b, 'custom_field_8215')
  row.AddAddressCity = pick(b, 'custom_field_8216')
  row.AddAddressPOBox = pick(b, 'custom_field_8217')
  row.AddAddressDistrict = pick(b, 'custom_field_8218')
  row.AddAddressCountry = pickCode(pick(b, 'custom_field_8219'))
  row.AddAddressLivedSince = fmtDDMMYYYY(pick(b, 'custom_field_8220'))

  row.DocumentType = pickCode(pick(b, 'custom_field_8221'))
  row.DocumentNumber = pick(b, 'custom_field_8222')
  row.DocumentIssueDate = fmtDDMMYYYY(pick(b, 'custom_field_8223'))
  row.DocumentIssueCountry = pickCode(pick(b, 'custom_field_8224'))
  row.AddDocumentType = pickCode(pick(b, 'custom_field_8225'))
  row.AddDocumentNumber = pick(b, 'custom_field_8226')
  row.AddDocumentIssueDate = fmtDDMMYYYY(pick(b, 'custom_field_8227'))
  row.AddDocumentIssueCountry = pickCode(pick(b, 'custom_field_8228'))

  row.Landline = pick(b, 'custom_field_8229', 'borrower_landline')
  row.MobilePhone = pick(b, 'custom_field_8230', 'borrower_mobile')
  row.AdditionalMobile = pick(b, 'custom_field_8231')
  row.Email = pick(b, 'borrower_email', 'custom_field_8232')

  row.SoleTradeName = pick(b, 'custom_field_8233')
  row.SoleTradeVAT = pick(b, 'custom_field_8234')
  row.SoleTradeBRN = pick(b, 'custom_field_8235')
  row.SoleTradeRegCity = pick(b, 'custom_field_8236')
  row.SoleTradeEstablishDate = fmtDDMMYYYY(pick(b, 'custom_field_8237'))
  row.SoleTradePhone = pick(b, 'custom_field_8238')

  row.EmployerName =
    pick(b, 'custom_field_8239') || pick(loan, 'custom_field_10558', 'custom_field_9404')
  row.OccupationStatus = pickCode(pick(b, 'custom_field_8240'))
  row.EmploymentPhone = pick(b, 'custom_field_8241') || pick(loan, 'custom_field_11176')
  row.DateHired = fmtDDMMYYYY(pick(b, 'custom_field_8242'))
  row.DateTerminated = fmtDDMMYYYY(pick(b, 'custom_field_8243'))
  row.Occupation = pick(b, 'custom_field_8244')
  row.JobTitle = pick(b, 'custom_field_8245')
  row.GrossAnnualIncome = pick(b, 'custom_field_8246') || pick(loan, 'custom_field_10565')

  row.PrevEmployerName = pick(b, 'custom_field_8247')
  row.PrevOccupationStatus = pickCode(pick(b, 'custom_field_8248'))
  row.PrevEmploymentPhone = pick(b, 'custom_field_8249')
  row.PrevDateHired = fmtDDMMYYYY(pick(b, 'custom_field_8250'))
  row.PrevDateTerminated = fmtDDMMYYYY(pick(b, 'custom_field_8251'))
  row.PrevOccupation = pick(b, 'custom_field_8252')
  row.PrevJobTitle = pick(b, 'custom_field_8253')
  row.PrevGrossAnnualIncome = pick(b, 'custom_field_8254')

  return row
}

export function buildContractRow(loan, b, repayment, batch, branchId) {
  const row = {}
  for (const col of CONTRACT_COLUMNS) row[col] = ''

  const daysPastDue = Number(pick(loan, 'days_past_due', 'custom_field_7788')) || 0
  const numPastDue = daysPastDue > 0 ? '1' : '0'
  const amountPastDue = daysPastDue > 0 ? pick(loan, 'past_due', 'custom_field_7784') : '0'
  const startDate = fmtDDMMYYYY(pick(loan, 'custom_field_7766', 'loan_released_date', 'custom_field_10568'))
  const duration = Number(pick(loan, 'loan_duration')) || 0

  row.HeaderRT = 'H'
  row.ContractRT = 'D'
  row.FooterRT = 'Q'
  row.FICode =
    pick(loan, 'custom_field_6831', 'custom_field_6813') ||
    pick(b, 'custom_field_6813') ||
    batch.FICode ||
    'SILML'
  row.AccountingDate = batch.AccountingDate
  row.ProductionDate = batch.ProductionDate
  row.PrograssiveNumber = batch.PrograssiveNumber
  row.CorrectionFlag = ''

  row.BranchCode = pick(loan, 'custom_field_7768', 'custom_field_7767') || String(branchId)
  row.FISubjectCode = pick(loan, 'borrower_id') || pick(b, 'borrower_id')
  row.FIContractCode = pick(loan, 'loan_application_id', 'loan_id')
  row.ContractType = pickCode(pick(loan, 'custom_field_6829')) || '11'
  row.ContractPhase = mapContractPhase(pick(loan, 'loan_status_id'))
  row.ContractStatus = ''
  row.Currency = pickCode(pick(loan, 'custom_field_6827', 'custom_field_8266')) || 'BSD'
  row.OriginalCurrency = pickCode(pick(loan, 'custom_field_8267', 'custom_field_6827')) || 'BSD'
  row.StartDate = startDate
  row.ContractRequestDate = fmtDDMMYYYY(pick(loan, 'custom_field_8269')) || startDate
  row.MaturityDate =
    fmtDDMMYYYY(pick(loan, 'custom_field_7765', 'due_date', 'loan_override_maturity_date')) ||
    (startDate && duration ? addMonthsToDDMMYYYY(startDate, duration) : '')
  row.ContractEndActualDate = fmtDDMMYYYY(pick(loan, 'custom_field_8270'))
  row.PaymentMadeDate = fmtDDMMYYYY(pick(repayment, 'repayment_collected_date', 'custom_field_8271'))
  row.FlagReorganizedCredit = pickCode(pick(loan, 'custom_field_10796')) || '0'
  row.PersonalGuaranteeType = ''
  row.RealGuaranteeType = ''
  row.AmountPersonalGuarantee = ''
  row.AmountRealGuarantee = ''
  row.MaxPaymentsPastDue = numPastDue
  row.MonthsMaxOverdue = daysPastDue > 0 ? '1' : '0'
  row.MaxDaysPastDue = mapDaysPastDueBucket(daysPastDue)
  row.WorstStatus = ''
  row.DateMaxInsolvency = ''

  row.FinancedAmount = pick(loan, 'loan_principal_amount', 'custom_field_7781')
  row.NumberOfInstalments = pick(loan, 'loan_num_of_repayments', 'loan_duration', 'custom_field_7782')
  row.PaymentFrequency = pickCode(pick(loan, 'custom_field_6826', 'custom_field_8285')) || 'M'
  row.MethodOfPayment = pickCode(pick(loan, 'custom_field_8286')) || '001'
  row.MonthlyInstalmentAmount = calcMonthlyInstalment(loan)
  row.NextPaymentDate = fmtDDMMYYYY(pick(loan, 'due_date', 'loan_first_repayment_date'))
  row.NextPaymentAmount =
    pick(loan, 'first_repayment_amount', 'amortization', 'custom_field_8288') || row.MonthlyInstalmentAmount
  row.OutstandingPaymentsNumber = pick(loan, 'custom_field_7786') || calcOutstandingPayments(loan)
  row.OutstandingBalance = pick(loan, 'principal_balance_amount', 'custom_field_7785', 'balance_amount')
  row.NumberPaymentsPastDue = pick(loan, 'custom_field_7787') || numPastDue
  row.AmountPastDue = amountPastDue
  row.DaysPastDue = mapDaysPastDueBucket(daysPastDue)
  row.LeasedGoodType = ''
  row.LeasedGoodValue = ''
  row.LeasedGoodNewUsed = ''
  row.LeasedGoodBrand = ''
  row.LeasedGoodRegistration = ''
  row.LeasedGoodManufactureDate = ''
  row.RealDaysPastDue = pick(loan, 'custom_field_8297', 'days_past_due') || '0'

  return row
}
