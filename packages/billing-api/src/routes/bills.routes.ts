import { Router, type RequestHandler } from 'express';
import { assertSelfOrAdmin, requireRole } from '../auth/middleware';
import { parse } from '../http/middleware';
import type { BillService } from '../services/bill.service';
import { detailedQuery, periodBody, periodQuery, subscriberNo } from './schemas';

export function billRoutes(bills: BillService, authenticate: RequestHandler): Router {
  const r = Router();

  r.post('/api/v1/bills/calculate', authenticate, requireRole('ADMIN'), async (req, res) => {
    res.status(200).json(await bills.calculate(parse(periodBody, req.body)));
  });

  // Public by spec (Varsayımlar); the agent still only queries the logged-in subscriber.
  r.get('/api/v1/bills/:subscriberNo', async (req, res) => {
    const no = parse(subscriberNo, req.params.subscriberNo);
    const q = parse(periodQuery, req.query);
    res.json(await bills.query({ subscriberNo: no, ...q }));
  });

  r.get('/api/v1/bills/:subscriberNo/detailed', authenticate, async (req, res) => {
    const no = parse(subscriberNo, req.params.subscriberNo);
    assertSelfOrAdmin(req, no); // 403 before any lookup: no hint whether the bill exists
    const { page, pageSize, ...q } = parse(detailedQuery, req.query);
    res.json(await bills.detailed({ subscriberNo: no, ...q }, page, pageSize));
  });

  return r;
}
