import "dotenv/config";
import express from "express";
import { getTenantPool } from "./lib/db";
import { tenantMiddleware } from "./middleware/tenant.middleware";

import studentsRouter from "./routes/student.routes";
import usersRouter from "./routes/user.routes";
import subjectsRouter from "./routes/subject.routes";
import localEventsRouter from "./routes/local-event.routes";

const app = express();
app.use(express.json());

// --------------------
// Initialize tenant
// --------------------
const tenantId = process.env.TENANT_ID;
if (!tenantId) throw new Error("TENANT_ID is not defined");

app.locals.tenantId = tenantId;

// ✅ Create pool now
getTenantPool(tenantId);

// --------------------
// Apply tenant middleware
// --------------------
app.use(tenantMiddleware);

// --------------------
// Mount routers
// --------------------
app.use("/students", studentsRouter);
app.use("/users", usersRouter);
app.use("/subjects", subjectsRouter);
app.use("/local-events", localEventsRouter);

// --------------------
// Start server
// --------------------
app.listen(3000, () => {
    console.log(`Tenant service running for ${tenantId} on port 3000`);
});
