import { useEffect, useState } from 'react'

export function CountUp({ end, duration = 800, decimals = 0, prefix = '', suffix = '', className = '' }) {
  const [val, setVal] = useState(0)

  useEffect(() => {
    const target = Number(end) || 0
    const start = performance.now()
    let frame

    function tick(now) {
      const p = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(target * eased)
      if (p < 1) frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [end, duration])

  const formatted =
    decimals > 0 ? val.toFixed(decimals) : Math.round(val).toLocaleString()

  return (
    <span className={className}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  )
}
