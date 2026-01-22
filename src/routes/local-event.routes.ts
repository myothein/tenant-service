import { Router } from "express";
import {
    fetchPendingEvents,
    markEventSent
} from "../services/local-event.service";
import { tenantHandler } from "../utils/tenant-handler";

const router = Router();

/* ======================
   Fetch pending local events
   GET /local-events/pending
====================== */
router.get(
    "/pending",
    tenantHandler(fetchPendingEvents)
);

/* ======================
   Mark event as sent (ACK)
   PATCH /local-events/:id/mark-sent
====================== */
router.patch(
    "/:id/mark-sent",
    tenantHandler(markEventSent)
);

export default router;
