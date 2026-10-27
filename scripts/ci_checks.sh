#!/usr/bin/env bash
# The checks .github/workflows/ci.yml runs, in one script so AWS CodeBuild (lunar-prime-scaffold
# deploy/aws-checks) and a laptop run them alike: install, Prisma client, typecheck, lint, tests
# (the *.db.test.ts suites against a real Postgres), build, then known critical advisories.
#   TEST_DATABASE_URL set: use that Postgres; otherwise Postgres 16 starts in Docker.
# Output goes to ci-logs/<step>.log; ci-logs/summary.txt lists pass or fail per step.
set -uo pipefail
cd "$(dirname "$0")/.."
rm -rf ci-logs && mkdir -p ci-logs

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  # The ECR Public mirror of the Docker Hub image, so shared build hosts are not rate limited.
  docker run -d --name openreply-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 public.ecr.aws/docker/library/postgres:16 >/dev/null
  for _ in $(seq 1 60); do docker exec openreply-pg pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done
  export TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
fi
# Build-time placeholders only, the same as GitHub CI; nothing here reaches a real service.
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/instrareply REDIS_URL=redis://localhost:6379 \
  NEXTAUTH_URL=http://localhost:3000 NEXTAUTH_SECRET=test-secret-for-ci-build CRON_SECRET=test-secret-for-ci-cron \
  ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef RESEND_API_KEY=re_test \
  EMAIL_FROM="InstaReply <login@example.com>" META_GRAPH_API_VERSION=v25.0 INSTAGRAM_APP_ID=test \
  INSTAGRAM_APP_SECRET=test FACEBOOK_APP_SECRET=test WEBHOOK_VERIFY_TOKEN=test

failed=0
step() {
  local name=$1; shift
  if "$@" >"ci-logs/$name.log" 2>&1; then echo "$name pass" | tee -a ci-logs/summary.txt
  else echo "$name FAIL" | tee -a ci-logs/summary.txt; tail -n 60 "ci-logs/$name.log"; failed=1; fi
}
step install npm ci --no-audit --no-fund
step prisma npm run db:generate
step typecheck npm run typecheck
step lint npm run lint
step test npm test
step build npm run build
step security npm audit --omit=dev --audit-level=critical
docker rm -f openreply-pg >/dev/null 2>&1 || true
exit "$failed"
