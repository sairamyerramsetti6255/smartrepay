/**
 * Name matching regression tests — run: node server/engine/scripts/testNameMatch.js
 */
import { scoreNameMatch, nameScore } from '../src/nameMatch.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function testWilberson() {
  const annalisa = scoreNameMatch('Wilberson Smith', 'Annalisa Deandra Smith')
  assert(annalisa.score < 55, `Annalisa should not be viable, got ${annalisa.score} (${annalisa.kind})`)

  const wilberson = scoreNameMatch('Wilberson Smith', 'Wilberson Wilberforce Smith')
  assert(wilberson.score >= 85, `Wilberson full name should match strongly, got ${wilberson.score} (${wilberson.kind})`)
}

function testJamaal() {
  const clifford = scoreNameMatch('Jamaal Moss', 'Clifford Jamaal Moss')
  const lamar = scoreNameMatch('Jamaal Moss', 'Jamaal Lamar Moss')

  assert(
    lamar.score > clifford.score,
    `Jamaal Lamar (${lamar.score}) should beat Clifford (${clifford.score})`
  )
  assert(lamar.score >= 95, `Jamaal Lamar should be ~100, got ${lamar.score}`)
  assert(clifford.score < 95, `Clifford should be penalized, got ${clifford.score} (${clifford.kind})`)
}

function testLastOnlySingleToken() {
  const smithOnly = scoreNameMatch('Smith', 'Annalisa Deandra Smith')
  assert(smithOnly.kind.startsWith('last_only'), `Single token should use last_only, got ${smithOnly.kind}`)
}

function testNameScoreFirstToken() {
  const s = nameScore('Jamaal Moss', 'Clifford Jamaal Moss')
  assert(s < 100, `token_overlap should not be 100 for conflicting first names, got ${s}`)
}

const tests = [
  ['Wilberson vs Annalisa', testWilberson],
  ['Jamaal Moss cases', testJamaal],
  ['last_only for surname-only bank name', testLastOnlySingleToken],
  ['nameScore first-token gate', testNameScoreFirstToken],
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
