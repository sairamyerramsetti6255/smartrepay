import jwt from 'jsonwebtoken'

const SECRET = process.env.JWT_SECRET || 'smartrepay-dev-secret-change-in-production'

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, SECRET, { expiresIn: '7d' })
}

export function authMiddleware(req, res, next) {
  let token = null
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    token = header.slice(7)
  } else if (req.query?.token) {
    token = req.query.token
  }
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    const payload = jwt.verify(token, SECRET)
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), SECRET)
    } catch {
      /* ignore */
    }
  }
  next()
}
