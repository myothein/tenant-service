import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from './middleware/tenant.middleware';
import { requireApiRole } from './middleware/api-auth.middleware';
import { closeAllTenantPools } from './lib/db';

import subjectsRouter from './routes/subject.routes';
import localEventsRouter from './routes/local-event.routes';

/** Side-effect-free app creation permits isolated API security tests. */
export function createApp(tenantId: string = process.env.TENANT_ID || '') {
    const app = express();
    app.disable('x-powered-by');
    app.locals.tenantId = tenantId;
    app.use(express.json({ limit: '128kb' }));
    app.get('/health', (_req, res) => res.json({ status: 'alive' }));
    app.use(tenantMiddleware);

    app.use('/subjects', requireApiRole('admin'), subjectsRouter);
    app.use('/local-events', requireApiRole('agent'), localEventsRouter);

    // Existing students/user handlers are not compatible with db-helper schema or RBAC.
    // Never expose them until verified contracts, identity and test coverage are complete.
    app.use(['/students', '/users'], requireApiRole('admin'), (_req, res) => {
        res.status(501).json({ success: false, code: 'NOT_IMPLEMENTED' });
    });

    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const status = error && typeof error === 'object' && 'status' in error &&
            typeof error.status === 'number' && error.status >= 400 && error.status < 500
            ? error.status : 500;
        res.status(status).json({
            success: false, code: status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
            message: status === 500 ? 'Internal Server Error' : 'Request rejected'
        });
    });
    return app;
}

export const app = createApp();

if (require.main === module) {
    const tenantId = process.env.TENANT_ID || '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantId)) {
        throw new Error('Valid TENANT_ID is required');
    }
    const port = Number(process.env.PORT || 3001);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be a valid TCP port');
    }
    const server = app.listen(port, () => {
        console.log('Tenant service listening on port ' + port);
    });
    const shutdown = () => {
        server.close(() => void closeAllTenantPools().finally(() => process.exit(0)));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
