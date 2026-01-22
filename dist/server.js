"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const user_routes_1 = __importDefault(require("./routes/user.routes"));
const student_routes_1 = __importDefault(require("./routes/student.routes"));
const db_1 = require("./lib/db");
const tenant_middleware_1 = require("./middleware/tenant.middleware");
const app = (0, express_1.default)();
app.use(express_1.default.json());
const tenantId = process.env.TENANT_ID;
if (!tenantId) {
    throw new Error("TENANT_ID is not defined");
}
app.locals.tenantId = tenantId;
// Create pool AFTER env is ready
(0, db_1.getTenantPool)(tenantId);
// 🔥 APPLY ONCE — affects all routes
app.use(tenant_middleware_1.tenantMiddleware);
app.use("/students", student_routes_1.default);
app.use("/users", user_routes_1.default);
app.listen(3000, () => {
    console.log(`Tenant service running for ${tenantId} on port 3000`);
});
