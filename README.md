# Healthcare MRF Backend

A fully serverless AWS backend that accepts large JSON datasets from a browser (via IndexedDB), converts them to MRF (Machine-Readable File) format, and makes them publicly accessible — with no server in the data path.

---

## Table of contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Local development setup](#local-development-setup)
- [Environment variables](#environment-variables)
- [Deploying to AWS](#deploying-to-aws)
- [API reference](#api-reference)
- [How the upload flow works](#how-the-upload-flow-works)
- [Idempotency](#idempotency)
- [Useful commands](#useful-commands)

---

## Architecture

![AWS Serverless Architecture](https://jay-trambadiya-dev.s3.ap-south-1.amazonaws.com/diagram-export-5-26-2026-6_18_44-PM.png)

The system is split into four logical zones:

| Zone | Services | Responsibility |
|---|---|---|
| Client | Browser / React app | Auth via Cognito, IndexedDB export, direct S3 upload |
| API Gateway | HTTP API + JWT authorizer | Single entry point for all authenticated API calls |
| Compute | Lambda (presign, jobs, process) | Business logic — presign URLs, query jobs, convert MRF |
| Storage & Messaging | S3, SQS, DynamoDB | Durable storage, event buffering, job state |

### Request flow (numbered)

```
1.  Client authenticates with Cognito → receives JWT access token
2.  Client calls GET /jobs        → Jobs Lambda queries DynamoDB by userId
3.  Client calls GET /jobs/{id}   → Job Lambda fetches single record (ownership checked)
4.  Client calls POST /upload/presign → Presign Lambda:
      a. Writes PENDING record to DynamoDB
      b. Returns a 15-min presigned S3 PUT URL
5.  Client PUTs JSON directly to S3 (no server in the middle)
6.  S3 ObjectCreated → SQS standard queue (buffered, deduplication-safe)
7.  Process Lambda polls SQS, atomically claims job (PENDING → PROCESSING)
8.  Process Lambda reads raw JSON, converts to MRF, writes to public/mrf-files/
9.  Process Lambda updates DynamoDB → status=DONE, mrfFileUrl set
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 (ESM) |
| Infrastructure | AWS SAM (CloudFormation) |
| Auth | Amazon Cognito User Pool + Google IdP |
| API | HTTP API Gateway v2 + JWT authorizer |
| Compute | AWS Lambda (3 functions) |
| Queue | Amazon SQS standard queue + DLQ |
| Storage | Amazon S3 (uploads + public MRF output) |
| Database | Amazon DynamoDB (on-demand billing) |
| Frontend auth | AWS Amplify v6 (`aws-amplify`) |

---

## Project structure

```
mrf-app/
├── src/                          # All Lambda source code
│   ├── handlers/
│   │   ├── presignHandler.js     # POST /upload/presign
│   │   ├── jobsHandler.js        # GET /jobs  and  GET /jobs/{jobId}
│   │   └── processHandler.js     # SQS-triggered MRF conversion
│   ├── lib/
│   │   ├── dynamo.js             # DynamoDB client + table constants
│   │   ├── s3.js                 # S3 client + bucket constants
│   │   └── response.js           # Consistent HTTP response helpers
│   ├── middleware/
│   │   └── auth.js               # JWT claim extraction + withAuth() wrapper
│   └── package.json              # Lambda dependencies (lives inside src/)
├── infra/
│   ├── template.yaml             # SAM / CloudFormation template
│   └── samconfig.toml            # SAM deploy config (gitignored)
├── docs/
│   └── architecture.png          # Architecture diagram
├── frontend/                     # Vite + React frontend (separate app)
├── .env.example                  # Documents required env vars
├── .gitignore
└── README.md
```

---

## Prerequisites

Install these before doing anything else. Open PowerShell **as Administrator**:

```powershell
# Node.js 20 LTS
winget install OpenJS.NodeJS.LTS

# AWS CLI v2
winget install Amazon.AWSCLI

# AWS SAM CLI
winget install Amazon.SAM-CLI

# Git
winget install Git.Git
```

Verify after restarting PowerShell:

```powershell
node -v        # v20.x.x
npm -v         # 10.x.x
aws --version  # aws-cli/2.x.x
sam --version  # SAM CLI, version 1.x.x
git --version  # git version 2.x.x
```

You also need:

- An **AWS account** with an IAM user that has `AdministratorAccess` (or scoped SAM deploy permissions)
- A **Google Cloud project** with an OAuth 2.0 Web Client ID + Secret (for Google login)

---

## Local development setup

### 1. Clone and install

```powershell
git clone https://github.com/YOUR_USER/mrf-app.git
cd mrf-app

# Install Lambda dependencies (must be inside src/)
cd src
npm install
cd ..
```

### 2. Configure AWS credentials

```powershell
aws configure
# AWS Access Key ID:     <your key>
# AWS Secret Access Key: <your secret>
# Default region name:   ap-south-1
# Default output format: json
```

### 3. Set up environment variables

Copy the example file and fill in values (you'll get most of these after your first deploy):

```powershell
copy .env.example .env
```

```env
# Backend (used by SAM deploy parameter overrides)
S3_BUCKET_NAME=mrf-files-dev-YOUR_ACCOUNT_ID
DYNAMODB_TABLE_NAME=mrf-jobs-dev
FRONTEND_ORIGIN=http://localhost:5173

# Frontend (Vite — must be prefixed VITE_)
VITE_AWS_REGION=ap-south-1
VITE_COGNITO_USER_POOL_ID=ap-south-1_XXXXXXXX
VITE_COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxx
VITE_COGNITO_DOMAIN=https://mrf-auth-dev-ACCOUNTID.auth.ap-south-1.amazoncognito.com
VITE_API_BASE_URL=https://xxxxxxxxxx.execute-api.ap-south-1.amazonaws.com/dev
```

### 4. Run the frontend locally

```powershell
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

> The backend Lambdas run on AWS even during local development — SAM local is optional (see below). The frontend talks to your deployed API Gateway URL.

### 5. (Optional) Run Lambda locally with SAM

SAM can invoke individual Lambdas locally for quick testing without deploying:

```powershell
cd infra

# Invoke presignHandler with a test event
sam local invoke PresignFunction --event events/presign.json

# Start a local HTTP API (mirrors your API Gateway routes)
sam local start-api --port 3001
```

Create `infra/events/presign.json` for local testing:

```json
{
  "requestContext": {
    "authorizer": {
      "jwt": {
        "claims": {
          "sub": "test-user-123"
        }
      }
    }
  },
  "body": "{\"fileName\":\"test.json\",\"contentType\":\"application/json\"}"
}
```

---

## Environment variables

These are set automatically by SAM in Lambda — you don't set them manually in Lambda console.

| Variable | Set by | Used in |
|---|---|---|
| `DYNAMODB_TABLE_NAME` | SAM Globals | All handlers |
| `S3_BUCKET_NAME` | SAM Globals | presignHandler, processHandler |
| `FRONTEND_ORIGIN` | SAM Globals | response.js CORS headers |
| `AWS_DEFAULT_REGION` | Lambda runtime (automatic) | processHandler (buildPublicUrl) |

> `AWS_REGION` is reserved by Lambda — do not set it yourself. Use `AWS_DEFAULT_REGION` to read the region at runtime.

---

## Deploying to AWS

### First deploy (guided)

```powershell
cd infra
sam deploy --guided
```

SAM will prompt for:

| Prompt | Value |
|---|---|
| Stack name | `healthcare-backend` |
| AWS Region | `ap-south-1` |
| Env | `dev` |
| FrontendOrigin | `http://localhost:5173` (dev) or your prod URL |
| GoogleClientId | From Google Cloud Console |
| GoogleClientSecret | From Google Cloud Console |
| Confirm changes | `Y` |
| Allow SAM IAM role creation | `Y` |

After deploy, copy the **Outputs** printed in the terminal:

```
ApiUrl           → https://xxxxxxxxxx.execute-api.ap-south-1.amazonaws.com/dev
UserPoolId       → ap-south-1_XXXXXXXX
UserPoolClientId → xxxxxxxxxxxxxxxxxxxx
CognitoDomain    → https://mrf-auth-dev-ACCOUNTID.auth.ap-south-1.amazoncognito.com
BucketName       → mrf-files-dev-ACCOUNTID
```

Paste these into your frontend `.env` file.

### Subsequent deploys

```powershell
cd infra
sam deploy
```

### Tear down

```powershell
# Delete the stack (will fail if S3 bucket has objects — empty it first)
aws s3 rm s3://mrf-files-dev-YOUR_ACCOUNT_ID --recursive
aws cloudformation delete-stack --stack-name healthcare-backend --region ap-south-1
aws cloudformation wait stack-delete-complete --stack-name healthcare-backend --region ap-south-1
```

---

## API reference

All routes except auth require `Authorization: Bearer <accessToken>` header.

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/login` | None | Email + password login via Cognito |
| `GET` | `/auth/google` | None | Redirect to Google OAuth |
| `GET` | `/auth/callback` | None | OAuth callback — exchanges code for JWT |
| `POST` | `/auth/logout` | JWT | Revokes refresh token |

### Upload

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/upload/presign` | JWT | Returns a 15-min S3 presigned PUT URL. Also creates a `PENDING` DynamoDB record. |

**Request body:**
```json
{
  "fileName": "mrf_2025-01-01.json",
  "contentType": "application/json"
}
```

**Response:**
```json
{
  "jobId": "uuid-v4",
  "presignedUrl": "https://s3.amazonaws.com/...",
  "s3Key": "uploads/userId/jobId/filename.json",
  "expiresIn": 900
}
```

### Jobs

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/jobs` | JWT | All MRF jobs for the authenticated user, newest first |
| `GET` | `/jobs/{jobId}` | JWT | Single job — ownership verified against JWT `sub` |

**Job object:**
```json
{
  "jobId": "uuid-v4",
  "status": "PENDING | PROCESSING | DONE | FAILED",
  "isMrfFileReady": false,
  "mrfFileUrl": "https://s3.ap-south-1.amazonaws.com/bucket/public/mrf-files/...",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

---

## How the upload flow works

```
Client (IndexedDB)
  │
  ├─ 1. POST /upload/presign  ──→  Lambda creates DynamoDB record (PENDING)
  │                                returns { presignedUrl, jobId }
  │
  ├─ 2. PUT presignedUrl  ──────→  S3 uploads/ (direct, no server)
  │
  └─ Done. The rest is async:

S3 ObjectCreated event
  │
  ├─ SQS standard queue  (buffers duplicate events from S3)
  │
  └─ Process Lambda
       ├─ Atomic DynamoDB conditional write: PENDING → PROCESSING
       │   (duplicate events hit ConditionalCheckFailedException → skipped)
       ├─ Read JSON from S3 uploads/
       ├─ convertToMrf() — replace with your business logic
       ├─ Write output to S3 public/mrf-files/
       └─ Update DynamoDB: status=DONE, mrfFileUrl=<public url>
```

---

## Idempotency

S3 can fire duplicate `ObjectCreated` events for the same upload. The process Lambda guards against double-processing using a **DynamoDB conditional write** — not a read-then-check (which has a race condition with concurrent Lambda invocations):

```js
// Only succeeds if status is still PENDING
ConditionExpression: "#status = :pending"
```

If the condition fails (`ConditionalCheckFailedException`), the Lambda exits cleanly and SQS deletes the message. A job stuck at `PROCESSING` (Lambda crashed mid-flight) stays stuck intentionally — monitor via CloudWatch and reset manually if needed.

---

## Useful commands

```powershell
# View live Lambda logs
aws logs tail /aws/lambda/mrf-presign-dev --follow --region ap-south-1
aws logs tail /aws/lambda/mrf-jobs-dev --follow --region ap-south-1
aws logs tail /aws/lambda/mrf-process-dev --follow --region ap-south-1

# Get your Cognito access token for manual API testing
aws cognito-idp initiate-auth `
  --auth-flow USER_PASSWORD_AUTH `
  --client-id YOUR_CLIENT_ID `
  --auth-parameters USERNAME=you@email.com,PASSWORD=yourpassword `
  --region ap-south-1 `
  --query "AuthenticationResult.AccessToken" `
  --output text

# Test presign endpoint manually
curl.exe -X POST https://YOUR_API_URL/dev/upload/presign `
  -H "Authorization: Bearer TOKEN" `
  -H "Content-Type: application/json" `
  -d "{\"fileName\":\"test.json\",\"contentType\":\"application/json\"}"

# Check DynamoDB jobs for a user
aws dynamodb query `
  --table-name mrf-jobs-dev `
  --key-condition-expression "userId = :uid" `
  --expression-attribute-values "{\":uid\":{\"S\":\"YOUR_USER_SUB\"}}" `
  --region ap-south-1

# Check SQS dead-letter queue for failed messages
aws sqs get-queue-attributes `
  --queue-url https://sqs.ap-south-1.amazonaws.com/ACCOUNT/mrf-processing-dlq-dev `
  --attribute-names ApproximateNumberOfMessages `
  --region ap-south-1

# Empty S3 bucket (required before stack delete)
aws s3 rm s3://mrf-files-dev-YOUR_ACCOUNT_ID --recursive
```