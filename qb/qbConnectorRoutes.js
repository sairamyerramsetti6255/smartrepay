import express from 'express'
import { connectorAuth, heartbeat, claimDelivery, acknowledgeDelivery } from './qbDesktopService.js'
export function createConnectorRouter(db) {
  const router = express.Router()
  router.use(connectorAuth)
  const handle = fn => (req,res) => { try { res.json(fn(req)) } catch(e) { res.status(400).json({error:e.message}) } }
  router.post('/heartbeat',handle(req => heartbeat(db,req.body)))
  router.post('/claim',handle(() => ({delivery:claimDelivery(db)})))
  router.post('/deliveries/:id/ack',handle(req => acknowledgeDelivery(db,req.params.id,req.body)))
  return router
}
