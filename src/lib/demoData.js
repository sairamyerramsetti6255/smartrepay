import * as api from './api'

export async function getDataCounts() {
  try {
    const counts = await api.demo.counts()
    return { ...counts, error: null }
  } catch (e) {
    return { borrowers: 0, transactions: 0, exceptions: 0, error: e.message }
  }
}

export async function loadDemoData(actorEmail) {
  const result = await api.demo.seed()
  return { borrowers: result.borrowers, transactionsAdded: result.transactionsAdded }
}
