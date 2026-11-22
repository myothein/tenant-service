import { Router } from 'express';
import { fetchPendingEvents, markEventSent } from '../services/local-event.service';

const router = Router();
router.get('/pending', fetchPendingEvents);
router.patch('/:id/mark-sent', markEventSent);
export default router;
