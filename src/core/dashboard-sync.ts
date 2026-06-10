/**
 * Self-registering CloudWatch usage dashboard.
 *
 * The dashboard definition (infra/cloudwatch-usage-dashboard.json) is baked
 * into the container image, and on startup (serve mode) the server pushes it
 * to CloudWatch via PutDashboard. This makes the dashboard part of the image
 * deploy itself: push a new image → ECS auto-redeploys → the new task syncs
 * whatever dashboard definition shipped in that image. One operation, no
 * separate put-dashboard / CloudFormation step.
 *
 * Failure is non-fatal by design: if the ECS task role lacks
 * cloudwatch:PutDashboard (see infra/IAM-TASK-ROLE.md) the sync logs a
 * warning and the server keeps serving. The dashboard simply appears on the
 * first task start after the permission lands.
 *
 * Opt out with USAGE_DASHBOARD_SYNC=false. Override the dashboard name with
 * USAGE_DASHBOARD_NAME.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CloudWatchClient, PutDashboardCommand } from '@aws-sdk/client-cloudwatch';
import { Logger } from '@utils/logger.js';

const DEFAULT_DASHBOARD_NAME = 'Productboard-MCP-Usage-Monitoring';

export async function syncUsageDashboard(logger: Logger): Promise<void> {
  if (process.env.USAGE_DASHBOARD_SYNC === 'false') {
    logger.info('usage dashboard sync disabled (USAGE_DASHBOARD_SYNC=false)');
    return;
  }

  const dashboardName = process.env.USAGE_DASHBOARD_NAME || DEFAULT_DASHBOARD_NAME;
  const bodyPath = join(process.cwd(), 'infra', 'cloudwatch-usage-dashboard.json');

  let raw: string;
  try {
    raw = readFileSync(bodyPath, 'utf-8');
  } catch {
    logger.warn('usage dashboard sync skipped — definition not found in image', {
      expected_path: bodyPath,
    });
    return;
  }

  let parsed: { widgets?: unknown[] };
  try {
    parsed = JSON.parse(raw) as { widgets?: unknown[] };
  } catch (err) {
    logger.warn('usage dashboard sync skipped — definition is not valid JSON', {
      err: (err as Error).message,
    });
    return;
  }
  if (!Array.isArray(parsed.widgets) || parsed.widgets.length === 0) {
    logger.warn('usage dashboard sync skipped — definition has no widgets array');
    return;
  }

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const client = new CloudWatchClient({ region });

  try {
    const res = await client.send(
      new PutDashboardCommand({
        DashboardName: dashboardName,
        DashboardBody: JSON.stringify(parsed),
      }),
    );
    const validationMessages = res.DashboardValidationMessages ?? [];
    if (validationMessages.length > 0) {
      logger.warn('usage dashboard synced with validation messages', {
        dashboard: dashboardName,
        messages: validationMessages,
      });
    } else {
      logger.info('usage dashboard synced', {
        dashboard: dashboardName,
        widgets: parsed.widgets.length,
        region,
      });
    }
  } catch (err) {
    // Most likely AccessDeniedException: the ECS task role doesn't have
    // cloudwatch:PutDashboard yet. Non-fatal — serve traffic regardless.
    logger.warn('usage dashboard sync failed — continuing without it', {
      dashboard: dashboardName,
      err: (err as Error).message,
      hint: 'task role needs cloudwatch:PutDashboard — see infra/IAM-TASK-ROLE.md',
    });
  } finally {
    client.destroy();
  }
}
