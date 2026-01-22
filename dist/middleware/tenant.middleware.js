"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tenantMiddleware = tenantMiddleware;
function tenantMiddleware(req, _res, next) {
    const tenantId = req.app.locals.tenantId;
    if (!tenantId) {
        throw new Error("Tenant not initialized on app.locals");
    }
    req.tenantId = tenantId;
    next();
}
