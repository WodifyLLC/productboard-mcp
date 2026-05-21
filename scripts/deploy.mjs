#!/usr/bin/env node
/**
 * Build + deploy the productboard-mcp Docker image.
 *
 * Mirrors the deploy script in the g-suite-mcp repo so both MCPs follow the
 * same ECR/ECS workflow.
 *
 * Targets:
 *   docker-desktop   Build locally and run as a container on your laptop.
 *                    Reads the API token from your local .env via -e flags.
 *                    No registry push.
 *
 *   ecr              Build, tag, and push to AWS ECR. Optionally trigger a
 *                    new ECS deployment. Requires AWS CLI configured with
 *                    credentials that can write to the ECR repo + (if
 *                    updating service) update the ECS service.
 *
 * Usage:
 *   node scripts/deploy.mjs                       (defaults to docker-desktop)
 *   node scripts/deploy.mjs docker-desktop
 *   node scripts/deploy.mjs ecr
 *
 * Common env vars:
 *   IMAGE_NAME           Image name (default: productboard-mcp)
 *   IMAGE_TAG            Tag (default: latest)
 *
 * Docker Desktop target:
 *   CONTAINER_NAME       Container name (default: productboard-mcp)
 *   HOST_PORT            Host port to map (default: 8000)
 *   PRODUCTBOARD_API_TOKEN  Required for the local container to do anything.
 *   PRODUCTBOARD_READ_ONLY  Default "true" (Wodify safety default).
 *   LOG_LEVEL            Default "error".
 *
 * ECR target:
 *   AWS_REGION           Required
 *   ECR_REGISTRY         e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com
 *   ECR_REPO             Repository name (default: productboard-mcp)
 *   ECS_CLUSTER          (optional) Cluster name; if set with ECS_SERVICE,
 *                        triggers a new deployment
 *   ECS_SERVICE          (optional) Service name
 */

import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig } from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env so the script picks up the same secrets the local dev does.
dotenvConfig({ path: path.join(ROOT, ".env") });

const TARGET = (process.argv[2] || "docker-desktop").toLowerCase();
const IMAGE_NAME = process.env.IMAGE_NAME || "productboard-mcp";
const IMAGE_TAG = process.env.IMAGE_TAG || "latest";
const LOCAL_IMAGE = `${IMAGE_NAME}:${IMAGE_TAG}`;

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function tryRun(cmd) {
  try {
    execSync(cmd, { stdio: "inherit", cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

function ensureDockerRunning() {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(
      "Docker daemon is not reachable. Start Docker Desktop and rerun this script.\n" +
        "(docker info exit code: " +
        r.status +
        ")"
    );
    process.exit(1);
  }
}

function buildImage() {
  ensureDockerRunning();
  run(`docker build -t ${LOCAL_IMAGE} .`);
}

function deployDockerDesktop() {
  buildImage();

  const containerName = process.env.CONTAINER_NAME || "productboard-mcp";
  const hostPort = process.env.HOST_PORT || "8000";

  const required = ["PRODUCTBOARD_API_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      `Missing required env vars: ${missing.join(", ")}. ` +
        `Set them in .env or in your shell before running deploy.`
    );
    process.exit(1);
  }

  // Stop + remove any prior container of the same name (ignore failure).
  tryRun(`docker stop ${containerName}`);
  tryRun(`docker rm ${containerName}`);

  const envFlags = [
    `-e PRODUCTBOARD_API_TOKEN="${process.env.PRODUCTBOARD_API_TOKEN}"`,
    `-e PRODUCTBOARD_AUTH_TYPE="${process.env.PRODUCTBOARD_AUTH_TYPE || "bearer"}"`,
    `-e PRODUCTBOARD_READ_ONLY="${process.env.PRODUCTBOARD_READ_ONLY ?? "true"}"`,
    `-e LOG_LEVEL="${process.env.LOG_LEVEL || "error"}"`,
    `-e NODE_ENV="${process.env.NODE_ENV || "production"}"`,
  ].join(" ");

  run(
    [
      "docker run -d",
      `--name ${containerName}`,
      // Container listens on 8000 (matches managed-ECS hosting contract).
      `-p ${hostPort}:8000`,
      envFlags,
      "--restart unless-stopped",
      LOCAL_IMAGE,
    ].join(" ")
  );

  console.log(`\nContainer "${containerName}" started.`);
  console.log(`  Health: http://localhost:${hostPort}/healthz`);
  console.log(`  MCP:    http://localhost:${hostPort}/mcp`);
  console.log(`  Logs:   docker logs -f ${containerName}`);
}

function deployEcr() {
  buildImage();

  const region = process.env.AWS_REGION;
  const registry = process.env.ECR_REGISTRY;
  const repo = process.env.ECR_REPO || "productboard-mcp";
  if (!region || !registry) {
    console.error(
      "ecr target requires AWS_REGION and ECR_REGISTRY env vars (ECR_REPO optional, defaults to productboard-mcp)."
    );
    process.exit(1);
  }

  const remoteTag = `${registry}/${repo}:${IMAGE_TAG}`;
  const versionedTag = `${registry}/${repo}:${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19)}`;

  run(`docker tag ${LOCAL_IMAGE} ${remoteTag}`);
  run(`docker tag ${LOCAL_IMAGE} ${versionedTag}`);

  // ECR login. Requires aws CLI installed and credentials configured.
  run(
    `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
    { shell: true }
  );

  run(`docker push ${remoteTag}`);
  run(`docker push ${versionedTag}`);

  if (process.env.ECS_CLUSTER && process.env.ECS_SERVICE) {
    run(
      `aws ecs update-service --region ${region} ` +
        `--cluster ${process.env.ECS_CLUSTER} ` +
        `--service ${process.env.ECS_SERVICE} ` +
        `--force-new-deployment`
    );
    console.log("\nECS service redeploy triggered.");
  } else {
    console.log(
      "\nPushed to ECR. (Set ECS_CLUSTER + ECS_SERVICE to also trigger a service redeploy.)"
    );
  }
}

switch (TARGET) {
  case "docker-desktop":
  case "local":
    deployDockerDesktop();
    break;
  case "ecr":
  case "aws":
    deployEcr();
    break;
  default:
    console.error(
      `Unknown target "${TARGET}". Use "docker-desktop" or "ecr".`
    );
    process.exit(1);
}
