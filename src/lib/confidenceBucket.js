export const CONFIDENCE_BUCKET_LABELS = {
  same_person: 'Same person',
  very_likely_match: 'Very likely',
  possible_review: 'Review',
  different_person: 'Different person',
}

export function confidenceBucket(confidence) {
  const c = Number(confidence) || 0
  if (c >= 95) return 'same_person'
  if (c >= 85) return 'very_likely_match'
  if (c >= 70) return 'possible_review'
  return 'different_person'
}

export function parseBucketFromReasoning(reasoning) {
  const m = String(reasoning || '').match(/^\[([a-z_]+)\]\s*/)
  return m ? m[1] : null
}

export function resolveConfidenceBucket(row) {
  if (row?.confidence_bucket) return row.confidence_bucket
  const parsed = parseBucketFromReasoning(row?.reasoning)
  if (parsed) return parsed
  return confidenceBucket(row?.confidence_score ?? 0)
}

export function bucketVariant(bucket) {
  switch (bucket) {
    case 'same_person':
      return 'on_track'
    case 'very_likely_match':
      return 'posted'
    case 'possible_review':
      return 'pending'
    default:
      return 'exception'
  }
}
