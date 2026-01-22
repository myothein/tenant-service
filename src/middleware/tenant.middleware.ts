import { Request, Response, NextFunction } from "express";
import { TenantRequest } from "../types/tenant-request";

/**
 * Middleware to inject tenantId into request.
 * Safe for TypeScript.
 */
export function tenantMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction
) {
    const tenantId = req.app.locals.tenantId;
    if (!tenantId) {
        throw new Error("Tenant not initialized on app.locals");
    }

    // Cast safely
    (req as TenantRequest).tenantId = tenantId;

    next();
}
