#!/usr/bin/env node
import { applyMonthlyBulkBorrowerUniqueNumberMigration } from '../monthlyBulkSql.js'

const result = await applyMonthlyBulkBorrowerUniqueNumberMigration()
console.log('MonthlyBulk borrowerUniqueNumber migration complete:')
console.log(JSON.stringify(result, null, 2))
