import { Request, Response, NextFunction } from 'express';
import { TenantRequest } from '../types/tenant-request';

/** Tenant identity always comes from deployment configuration, never request headers. */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.app.locals.tenantId as string | undefined;
    if (!tenantId || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
        return res.status(503).json({
            success: false, code: 'TENANT_NOT_CONFIGURED', message: 'Tenant unavailable'
        });
    }
    if (req.headers['x-tenant-id'] !== undefined || req.headers['x-tenant-code'] !== undefined) {
        return res.status(403).json({
            success: false, code: 'TENANT_HEADER_REJECTED', message: 'Tenant header not accepted'
        });
    }
    (req as TenantRequest).tenantId = tenantId;
    next();
}
