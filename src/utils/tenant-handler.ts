import { Request, Response, NextFunction } from "express";
import { TenantRequest } from "../types/tenant-request";

/**
 * Wraps an async route handler and casts Request to TenantRequest
 * Avoids repeating `(req as TenantRequest)` in every route
 */
export function tenantHandler(
    fn: (req: TenantRequest, res: Response, next: NextFunction) => Promise<void>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        return fn(req as TenantRequest, res, next);
    };
}
