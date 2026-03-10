# Inquiry Response System — Product Specification

## Overview

A web-based inquiry management platform that ingests submissions from Google Forms, processes them through a role-based workflow, and delivers responses via WhatsApp (private or group chat) using the WhatsApp Gateway Service (WGS).

**Tech Stack:**

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19.2 |
| Database | Neon (Serverless Postgres) + Prisma ORM |
| Auth | NextAuth.js v5 (credentials + invite-based) |
| WhatsApp | WhatsApp Gateway Service (self-hosted on Render) |
| Forms | Google Forms → Google Apps Script webhook |
| Hosting | Vercel (web app) + Render (WGS) |

---

## 1. User Roles & Permissions

### 1.1 Admin (מנהל)

| Capability | Description |
|-----------|-------------|
| Review inquiries | View all incoming form submissions |
| Filter & triage | Mark inquiries as valid/spam/duplicate |
| Set status | Update inquiry lifecycle status |
| Route to team | Assign an inquiry to a specific team |
| Manage users | Invite team leads and responders, assign roles |
| System settings | Configure allowed WhatsApp JIDs, teams, form mappings |
| Dashboard | View system-wide stats (pending, in-progress, sent, rejected) |

### 1.2 Team Lead (ראש צוות)

| Capability | Description |
|-----------|-------------|
| View team inbox | See inquiries routed to their team |
| Assign to responder | Delegate an inquiry to a team member |
| Self-assign | Take an inquiry to answer personally |
| Review answers | Approve or return a draft response for revision |
| Send response | Trigger WhatsApp message delivery to the recipient |
| Update status | Move inquiry through the workflow |

### 1.3 Responder (משיב)

| Capability | Description |
|-----------|-------------|
| View assignments | See inquiries assigned to them |
| Draft response | Write an answer for the inquiry |
| Submit for review | Send the draft to the team lead |
| Revise | Edit and resubmit if returned by the team lead |
| View sent confirmation | See notification when the response is delivered |

---

## 2. Inquiry Lifecycle

```
Google Form Submitted
        │
        ▼
  ┌─────────────┐
  │   PENDING    │  ← New inquiry lands in admin inbox
  └──────┬──────┘
         │ Admin reviews
         ▼
  ┌─────────────┐     ┌──────────┐
  │  APPROVED   │────▶│ REJECTED │  (dead end)
  └──────┬──────┘     └──────────┘
         │ Admin routes to team
         ▼
  ┌─────────────┐
  │  ASSIGNED   │  ← Team lead sees it in team inbox
  └──────┬──────┘
         │ Team lead assigns to responder (or self)
         ▼
  ┌─────────────┐
  │ IN_PROGRESS │  ← Responder is working on it
  └──────┬──────┘
         │ Responder submits draft
         ▼
  ┌─────────────┐
  │  IN_REVIEW  │  ← Team lead reviews the answer
  └──────┬──────┘
         │
    ┌────┴─────┐
    ▼          ▼
 APPROVED   REVISION_NEEDED
    │          │
    │          └──▶ Back to IN_PROGRESS
    ▼
  ┌─────────────┐
  │   SENDING   │  ← WhatsApp message in queue
  └──────┬──────┘
         │ WGS confirms delivery
         ▼
  ┌─────────────┐
  │    SENT     │  ← Final state
  └─────────────┘
```

### Status Enum

```typescript
enum InquiryStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  ASSIGNED = 'ASSIGNED',
  IN_PROGRESS = 'IN_PROGRESS',
  IN_REVIEW = 'IN_REVIEW',
  REVISION_NEEDED = 'REVISION_NEEDED',
  SENDING = 'SENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}
```

---

## 3. Database Schema (Prisma)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  TEAM_LEAD
  RESPONDER
}

enum InquiryStatus {
  PENDING
  APPROVED
  REJECTED
  ASSIGNED
  IN_PROGRESS
  IN_REVIEW
  REVISION_NEEDED
  SENDING
  SENT
  FAILED
}

model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String
  password  String   // hashed
  role      Role
  teamId    String?
  team      Team?    @relation(fields: [teamId], references: [id])
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  assignedInquiries Inquiry[]         @relation("AssignedResponder")
  reviewedDrafts    DraftResponse[]   @relation("ReviewedBy")
  authoredDrafts    DraftResponse[]   @relation("AuthoredBy")
  statusChanges     StatusChange[]
}

model Team {
  id        String   @id @default(cuid())
  name      String   @unique
  leadId    String?
  createdAt DateTime @default(now())

  // Relations
  members   User[]
  inquiries Inquiry[]
}

model Inquiry {
  id              String        @id @default(cuid())
  status          InquiryStatus @default(PENDING)

  // Google Form data
  formResponseId  String        @unique  // Google Form response ID for dedup
  submitterName   String
  submitterPhone  String?               // phone or WhatsApp JID
  submitterEmail  String?
  subject         String
  body            String                // full form response text
  rawPayload      Json                  // original form data as JSON

  // Routing
  teamId          String?
  team            Team?         @relation(fields: [teamId], references: [id])
  responderId     String?
  responder       User?         @relation("AssignedResponder", fields: [responderId], references: [id])

  // WhatsApp delivery
  targetJid       String?               // recipient JID (private or group)
  sentMessageId   String?               // WGS message ID after delivery
  sentAt          DateTime?

  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  // Relations
  drafts          DraftResponse[]
  statusHistory   StatusChange[]
}

model DraftResponse {
  id          String   @id @default(cuid())
  inquiryId   String
  inquiry     Inquiry  @relation(fields: [inquiryId], references: [id])
  authorId    String
  author      User     @relation("AuthoredBy", fields: [authorId], references: [id])
  content     String   // the drafted response text
  version     Int      @default(1)
  approved    Boolean  @default(false)
  reviewNote  String?  // feedback from team lead
  reviewerId  String?
  reviewer    User?    @relation("ReviewedBy", fields: [reviewerId], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model StatusChange {
  id         String        @id @default(cuid())
  inquiryId  String
  inquiry    Inquiry       @relation(fields: [inquiryId], references: [id])
  fromStatus InquiryStatus
  toStatus   InquiryStatus
  changedBy  String
  user       User          @relation(fields: [changedBy], references: [id])
  note       String?
  createdAt  DateTime      @default(now())
}
```

---

## 4. Application Structure (Next.js 16)

```
src/
├── app/
│   ├── layout.tsx                    # Root layout with providers
│   ├── page.tsx                      # Landing / redirect to dashboard
│   ├── login/
│   │   └── page.tsx                  # Auth page
│   │
│   ├── dashboard/
│   │   ├── layout.tsx                # Authenticated layout with sidebar
│   │   ├── page.tsx                  # Role-based dashboard (stats & overview)
│   │   │
│   │   ├── inquiries/
│   │   │   ├── page.tsx              # Inquiry list (filtered by role)
│   │   │   └── [id]/
│   │   │       └── page.tsx          # Inquiry detail + draft + send
│   │   │
│   │   ├── teams/
│   │   │   ├── page.tsx              # Team management (admin only)
│   │   │   └── [id]/
│   │   │       └── page.tsx          # Team detail & members
│   │   │
│   │   ├── users/
│   │   │   └── page.tsx              # User management (admin only)
│   │   │
│   │   └── settings/
│   │       └── page.tsx              # System config (allowed JIDs, webhooks)
│   │
│   └── api/
│       ├── auth/[...nextauth]/
│       │   └── route.ts              # NextAuth handler
│       │
│       ├── webhook/
│       │   ├── google-form/
│       │   │   └── route.ts          # POST — Google Apps Script sends form data here
│       │   └── whatsapp/
│       │       └── route.ts          # POST — WGS sends inbound messages + heartbeat
│       │
│       ├── inquiries/
│       │   ├── route.ts              # GET list, POST create (manual)
│       │   └── [id]/
│       │       ├── route.ts          # GET detail, PATCH update status
│       │       ├── assign/
│       │       │   └── route.ts      # POST assign to team or responder
│       │       ├── draft/
│       │       │   └── route.ts      # POST create draft, PUT update draft
│       │       ├── review/
│       │       │   └── route.ts      # POST approve or return draft
│       │       └── send/
│       │           └── route.ts      # POST trigger WhatsApp send via WGS
│       │
│       ├── teams/
│       │   └── route.ts              # CRUD teams
│       │
│       ├── users/
│       │   └── route.ts              # CRUD users
│       │
│       └── whatsapp/
│           ├── status/
│           │   └── route.ts          # Proxy GET to WGS /api/status
│           └── chats/
│               └── route.ts          # Proxy GET to WGS /api/chats
│
├── lib/
│   ├── prisma.ts                     # Prisma client singleton
│   ├── auth.ts                       # NextAuth config
│   ├── wgs-client.ts                 # WhatsApp Gateway Service API client
│   └── permissions.ts                # Role-based access helpers
│
├── components/
│   ├── ui/                           # Reusable primitives (shadcn/ui)
│   ├── inquiries/
│   │   ├── InquiryTable.tsx          # Sortable, filterable table
│   │   ├── InquiryDetail.tsx         # Full inquiry view
│   │   ├── StatusBadge.tsx           # Color-coded status pill
│   │   ├── AssignDialog.tsx          # Assign to team/responder modal
│   │   ├── DraftEditor.tsx           # Rich text response editor
│   │   ├── ReviewPanel.tsx           # Approve/return UI for team lead
│   │   └── SendConfirmation.tsx      # WhatsApp send confirmation dialog
│   ├── dashboard/
│   │   ├── StatsCards.tsx            # Pending / In Progress / Sent counts
│   │   └── WhatsAppStatus.tsx        # Live WGS connection indicator
│   └── layout/
│       ├── Sidebar.tsx               # Role-aware navigation
│       └── Header.tsx
│
└── types/
    └── index.ts                      # Shared TS types
```

---

## 5. Key Pages & UI Flows

### 5.1 Admin Dashboard

- **Stats cards**: Pending / Approved / In Progress / Sent / Failed counts
- **WhatsApp status indicator**: Polls `GET /api/whatsapp/status` — green/yellow/red dot
- **Recent inquiries table**: Sortable by date, status, team
- **Quick actions**: Approve, Reject, Route to Team (inline or modal)

### 5.2 Inquiry Detail Page (`/dashboard/inquiries/[id]`)

Displays differently based on role:

**Admin view:**
- Full form submission data
- Status timeline (from `StatusChange` records)
- Route to team selector
- Current draft (if any), read-only

**Team Lead view:**
- Inquiry details + assigned responder
- Assign to responder dropdown
- Draft review panel (approve / return with note)
- "Send via WhatsApp" button (only when draft is approved)
- WhatsApp chat selector (choose target JID from `/api/whatsapp/chats`)

**Responder view:**
- Inquiry question / details
- Draft editor (textarea / rich text)
- Submit for review button
- Review feedback (if returned for revision)
- Read-only sent confirmation

### 5.3 WhatsApp Send Flow

```
Team Lead clicks "Send Response"
        │
        ▼
  SendConfirmation dialog opens
  - Shows: recipient JID, message preview
  - Option to select from available chats (fetched from WGS)
        │
        ▼
  POST /api/inquiries/[id]/send
        │
        ▼
  Next.js API route:
  1. Validate user is TEAM_LEAD for this inquiry
  2. Fetch approved draft content
  3. POST to WGS /api/send { jid, text }
  4. Store sentMessageId on inquiry
  5. Update status → SENT
  6. Return confirmation
```

---

## 6. Google Forms Integration

### 6.1 Apps Script Webhook

Attach this script to your Google Form to POST submissions to your Next.js API:

```javascript
function onFormSubmit(e) {
  const response = e.response;
  const items = response.getItemResponses();

  const payload = {
    formResponseId: response.getId(),
    timestamp: response.getTimestamp().toISOString(),
    answers: {}
  };

  items.forEach(item => {
    payload.answers[item.getItem().getTitle()] = item.getResponse();
  });

  UrlFetchApp.fetch('https://your-app.vercel.app/api/webhook/google-form', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-API-KEY': 'your-form-webhook-secret' },
    payload: JSON.stringify(payload),
  });
}
```

### 6.2 Webhook Handler (`/api/webhook/google-form/route.ts`)

```typescript
// Pseudocode
export async function POST(request: Request) {
  // 1. Validate X-API-KEY header
  // 2. Parse and validate payload with Zod
  // 3. Check formResponseId uniqueness (prevent duplicates)
  // 4. Map form fields to Inquiry model:
  //    - answers["שם"] → submitterName
  //    - answers["טלפון"] → submitterPhone
  //    - answers["נושא"] → subject
  //    - answers["תיאור"] → body
  // 5. Create Inquiry with status PENDING
  // 6. Store full payload in rawPayload JSON field
  // 7. Return 201
}
```

---

## 7. WhatsApp Gateway Service Integration

### 7.1 WGS Client (`lib/wgs-client.ts`)

```typescript
const WGS_URL = process.env.WGS_URL;     // e.g. https://whatsapp-service.onrender.com
const WGS_KEY = process.env.WGS_API_KEY;

export const wgs = {
  async getStatus() {
    const res = await fetch(`${WGS_URL}/api/status`);
    return res.json();
  },

  async getChats() {
    const res = await fetch(`${WGS_URL}/api/chats`, {
      headers: { 'X-API-KEY': WGS_KEY },
    });
    return res.json();
  },

  async sendMessage(jid: string, text: string) {
    const res = await fetch(`${WGS_URL}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': WGS_KEY,
      },
      body: JSON.stringify({ jid, text }),
    });
    return res.json();
  },
};
```

### 7.2 Inbound Webhook Handler (`/api/webhook/whatsapp/route.ts`)

Receives messages and heartbeats from WGS:

```typescript
export async function POST(request: Request) {
  // 1. Validate X-API-KEY header matches WGS webhook key
  // 2. Parse body
  // 3. If body.type === 'heartbeat' → log + update WGS status cache
  // 4. If inbound message → optionally store/process
  //    (e.g., track replies from recipients)
}
```

### 7.3 Environment Variables (Next.js)

```env
# WhatsApp Gateway Service
WGS_URL=https://your-whatsapp-service.onrender.com
WGS_API_KEY=same-key-as-WGS-API_KEY

# WGS sends webhooks to this app — must match WGS WEBHOOK_API_KEY
WGS_WEBHOOK_SECRET=same-key-as-WGS-WEBHOOK_API_KEY

# Google Form webhook
FORM_WEBHOOK_SECRET=your-form-webhook-secret

# Database
DATABASE_URL=postgres://...@ep-xxx.us-east-2.aws.neon.tech/neondb

# Auth
NEXTAUTH_SECRET=random-secret
NEXTAUTH_URL=https://your-app.vercel.app
```

---

## 8. API Route Summary

### Inquiry Routes (authenticated)

| Method | Route | Roles | Description |
|--------|-------|-------|-------------|
| GET | `/api/inquiries` | ALL | List inquiries (filtered by role/team) |
| GET | `/api/inquiries/[id]` | ALL | Get inquiry detail |
| PATCH | `/api/inquiries/[id]` | ADMIN, TEAM_LEAD | Update status |
| POST | `/api/inquiries/[id]/assign` | ADMIN, TEAM_LEAD | Assign to team or responder |
| POST | `/api/inquiries/[id]/draft` | RESPONDER, TEAM_LEAD | Create/update draft response |
| POST | `/api/inquiries/[id]/review` | TEAM_LEAD | Approve or return draft |
| POST | `/api/inquiries/[id]/send` | TEAM_LEAD | Send via WhatsApp |

### Webhook Routes (API key auth)

| Method | Route | Source | Description |
|--------|-------|--------|-------------|
| POST | `/api/webhook/google-form` | Google Apps Script | Ingest form submissions |
| POST | `/api/webhook/whatsapp` | WGS | Inbound messages + heartbeat |

### Proxy Routes (authenticated, admin/team lead)

| Method | Route | Proxies To | Description |
|--------|-------|-----------|-------------|
| GET | `/api/whatsapp/status` | WGS `/api/status` | Connection health |
| GET | `/api/whatsapp/chats` | WGS `/api/chats` | Available WhatsApp chats |

---

## 9. Role-Based Access Control

```typescript
// lib/permissions.ts

const permissions = {
  ADMIN: [
    'inquiries:list:all',
    'inquiries:review',
    'inquiries:route',
    'inquiries:reject',
    'users:manage',
    'teams:manage',
    'settings:manage',
  ],
  TEAM_LEAD: [
    'inquiries:list:team',
    'inquiries:assign',
    'inquiries:draft',
    'inquiries:review',
    'inquiries:send',
  ],
  RESPONDER: [
    'inquiries:list:assigned',
    'inquiries:draft',
    'inquiries:submit',
  ],
} as const;
```

### Data Visibility Rules

| Role | Sees inquiries where... |
|------|------------------------|
| Admin | All inquiries |
| Team Lead | `inquiry.teamId === user.teamId` |
| Responder | `inquiry.responderId === user.id` |

---

## 10. Implementation Order

Build the system in this sequence:

### Phase 1 — Foundation
1. Initialize Next.js 16 project with TypeScript
2. Set up Prisma with Neon — run `prisma migrate dev` with the schema above
3. Implement NextAuth with credentials provider
4. Build role-based middleware (`lib/permissions.ts`)
5. Create base layout with sidebar navigation

### Phase 2 — Inquiry Pipeline
6. Build Google Forms webhook handler
7. Create inquiry list page with filters (status, team, date)
8. Build inquiry detail page (status timeline, form data display)
9. Implement admin triage flow (approve / reject / route to team)
10. Implement team lead assignment flow

### Phase 3 — Response Workflow
11. Build draft editor component for responders
12. Implement submit-for-review flow
13. Build review panel for team leads (approve / return with note)
14. Add revision loop (responder edits → resubmit)

### Phase 4 — WhatsApp Integration
15. Implement `wgs-client.ts` for WGS API communication
16. Build WhatsApp status indicator component
17. Build chat selector (fetch available JIDs from WGS)
18. Implement send flow (team lead sends approved response)
19. Handle WGS inbound webhook (heartbeat + message tracking)

### Phase 5 — Polish
20. Dashboard stats aggregation queries
21. Real-time status updates (polling or SSE for inquiry status changes)
22. Email/notification when inquiry is assigned or returned
23. Audit log page (from `StatusChange` table)
24. Mobile-responsive layout

---

## 11. Security Checklist

- [ ] All API routes validate session + role before proceeding
- [ ] Webhook endpoints validate `X-API-KEY` header
- [ ] Google Form webhook deduplicates by `formResponseId`
- [ ] WGS API key stored in env, never exposed to client
- [ ] Passwords hashed with bcrypt (cost factor ≥ 12)
- [ ] Prisma queries use parameterized inputs (no raw SQL injection)
- [ ] CORS on WGS allows only the Next.js domain
- [ ] Rate limiting on auth endpoints
- [ ] Input validation with Zod on all POST/PATCH handlers
- [ ] `targetJid` validated against allowed JID format before sending
