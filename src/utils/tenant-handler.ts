import { Request, Response, NextFunction } from 'express';
import { TenantRequest } from '../types/tenant-request';

/** Send rejected asynchronous handlers to Express error middleware. */
export function tenantHandler(
    fn: (req: TenantRequest, res: Response, next: NextFunction) => Promise<void>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req as TenantRequest, res, next)).catch(next);
    };
}
