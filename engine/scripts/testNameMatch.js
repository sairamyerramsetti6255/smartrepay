/**
 * Hybrid name matching regression tests — run: npm run test:name-match (from server/)
 */
import {
  scoreNameMatch,
  tokenConfidence,
  jaroWinkler,
  damerauSim,
  phoneticEqual,
  isFullNameMatch,
  nameTokens,
} from '../src/nameMatch.js'
import { confidenceBucket } from '../src/matchingEngine.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function testLindaIsrael() {
  const m = scoreNameMatch('LINDA ISREAL', 'LINDA ISRAEL')
  assert(m.score >= 90, `LINDA ISREAL vs ISRAEL should be 90+, got ${m.score} (${m.kind})`)
  assert(m.kind.includes('full'), `Expected full name kind, got ${m.kind}`)

  const last = tokenConfidence('isreal', 'israel')
  assert(last.damerau >= 0.8, `Damerau should catch transposition, got ${last.damerau}`)
  assert(jaroWinkler('isreal', 'israel') >= 0.85, 'Jaro-Winkler should be high for ISREAL/ISRAEL')
}

function testWilberson() {
  const annalisa = scoreNameMatch('Wilberson Smith', 'Annalisa Deandra Smith')
  assert(annalisa.score === 0, `Annalisa should score 0, got ${annalisa.score}`)

  const wilberson = scoreNameMatch('Wilberson Smith', 'Wilberson Wilberforce Smith')
  assert(wilberson.score >= 90, `Wilberson full name should be 90+, got ${wilberson.score}`)
}

function testJamaal() {
  const clifford = scoreNameMatch('Jamaal Moss', 'Clifford Jamaal Moss')
  const lamar = scoreNameMatch('Jamaal Moss', 'Jamaal Lamar Moss')
  assert(clifford.score === 0, `Clifford should score 0, got ${clifford.score}`)
  assert(lamar.score >= 90, `Jamaal Lamar should be 90+, got ${lamar.score}`)
}

function testFirstLastOnlyTier() {
  const partial = scoreNameMatch('Maria Garcia Lopez', 'Maria Lopez')
  assert(partial.score >= 70 && partial.score < 90, `First+last only 70–89, got ${partial.score}`)
  assert(!partial.kind.includes('full'), `Should not be full name, got ${partial.kind}`)
}

function testSingleToken() {
  assert(scoreNameMatch('Smith', 'Annalisa Deandra Smith').score === 0, 'Single token bank -> 0')
}

function testTypoFirstLast() {
  const typo = scoreNameMatch('Jon Smith', 'John Smith')
  assert(typo.score >= 70, `Typo first+last >= 70, got ${typo.score}`)
}

function testPhoneticAssist() {
  const sara = scoreNameMatch('Sara Conor', 'Sarah Connor')
  assert(sara.score >= 70, `Phonetic/typo assist >= 70, got ${sara.score} (${sara.kind})`)
}

function testInitialLastName() {
  const m = scoreNameMatch('Zephyrita Alexandrea K', 'Zephyrita Alexandrea Knowles')
  assert(m.score >= 90, `Initial last name should match 90+, got ${m.score} (${m.kind})`)

  const short = scoreNameMatch('Zephyrita K', 'Zephyrita Alexandrea Knowles')
  assert(short.score >= 70, `First + last initial should match, got ${short.score} (${short.kind})`)

  const wrong = scoreNameMatch('Zephyrita M', 'Zephyrita Alexandrea Knowles')
  assert(wrong.score === 0, `Wrong last initial should be 0, got ${wrong.score} (${wrong.kind})`)
}

function testBuckets() {
  assert(confidenceBucket(100) === 'same_person', '100 -> same_person')
  assert(confidenceBucket(90) === 'very_likely_match', '90 -> very_likely_match')
  assert(confidenceBucket(75) === 'possible_review', '75 -> possible_review')
  assert(confidenceBucket(0) === 'different_person', '0 -> different_person')
}

function testFullNameHelper() {
  assert(isFullNameMatch(nameTokens('Jamaal Moss'), nameTokens('Jamaal Lamar Moss')), 'subset full name')
}

const tests = [
  ['LINDA ISREAL vs ISRAEL', testLindaIsrael],
  ['Wilberson vs Annalisa', testWilberson],
  ['Jamaal Moss cases', testJamaal],
  ['first+last only tier', testFirstLastOnlyTier],
  ['single-token bank name', testSingleToken],
  ['typo first+last', testTypoFirstLast],
  ['phonetic assist', testPhoneticAssist],
  ['initial last name (K → Knowles)', testInitialLastName],
  ['confidence buckets', testBuckets],
  ['full name helper', testFullNameHelper],
]

let passed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`)
    process.exitCode = 1
  }
}

console.log(`\n${passed}/${tests.length} passed`)
process.exit(process.exitCode || 0)
