import { Router, type RequestHandler } from 'express';
import { assertSelfOrAdmin } from '../auth/middleware';
import { dollarsToCents } from '../domain/money';
import { parse } from '../http/middleware';
import type { PaymentService } from '../services/payment.service';
import { paymentBody } from './schemas';

export function paymentRoutes(payments: PaymentService, authenticate: RequestHandler): Router {
  const r = Router();
  r.post('/api/v1/payments', authenticate, async (req, res) => {
    const { amount, transactionId, ...period } = parse(paymentBody, req.body);
    assertSelfOrAdmin(req, period.subscriberNo);
    res.json(await payments.pay(period, transactionId, dollarsToCents(amount)));
  });
  return r;
}
