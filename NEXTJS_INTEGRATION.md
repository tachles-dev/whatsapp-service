# WhatsApp Gateway Service — Next.js Integration Guide

## Environment Variables

Add these to your Next.js `.env.local`:

```env
WGS_URL=https://your-whatsapp-service.onrender.com
WGS_API_KEY=same-value-as-API_KEY-in-WGS
WGS_WEBHOOK_SECRET=same-value-as-WEBHOOK_API_KEY-in-WGS
```

---

## 1. WGS Client (`lib/wgs-client.ts`)

A server-only module. Never import this on the client side.

```typescript
import 'server-only';

const WGS_URL = process.env.WGS_URL!;
const WGS_API_KEY = process.env.WGS_API_KEY!;

// ---------- Types (mirror from WGS) ----------

export enum ServiceStatus {
  INITIALIZING = 'INITIALIZING',
  QR_READY = 'QR_READY',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
}

interface ApiResponse<T = unknown> {
  success: boolean;
  timestamp: number;
  data?: T;
  error?: { code: string; message: string };
}

interface StatusData {
  status: ServiceStatus;
  uptime: number;
  connectedAt: number | null;
  lastDisconnect: number | null;
}

interface ChatMetadata {
  id: string;
  name: string;
  isGroup: boolean;
}

interface SendResult {
  msgId: string;
}

// ---------- Helpers ----------

async function wgsFetch<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(`${WGS_URL}${path}`, {
    ...init,
    headers: {
      'X-API-KEY': WGS_API_KEY,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  const body: ApiResponse<T> = await res.json();

  if (!body.success) {
    throw new Error(body.error?.message ?? `WGS error on ${path}`);
  }

  return body;
}

// ---------- Public API ----------

/** GET /api/status — no API key needed, public endpoint */
export async function getWhatsAppStatus(): Promise<StatusData> {
  const res = await fetch(`${WGS_URL}/api/status`, {
    next: { revalidate: 10 }, // cache for 10s in Next.js
  });
  const body: ApiResponse<StatusData> = await res.json();
  return body.data!;
}

/** GET /api/auth/qr — returns QR string or null if already connected */
export async function getQrCode(): Promise<string | null> {
  const body = await wgsFetch<{ qr: string | null }>('/api/auth/qr');
  return body.data?.qr ?? null;
}

/** GET /api/chats — list all available WhatsApp chats (cached in WGS Redis) */
export async function getChats(): Promise<ChatMetadata[]> {
  const body = await wgsFetch<ChatMetadata[]>('/api/chats');
  return body.data ?? [];
}

/** POST /api/send — send a WhatsApp message */
export async function sendMessage(jid: string, text: string, quotedId?: string): Promise<string> {
  const body = await wgsFetch<SendResult>('/api/send', {
    method: 'POST',
    body: JSON.stringify({ jid, text, quotedId }),
  });
  return body.data!.msgId;
}
```

---

## 2. API Routes

### 2.1 WhatsApp Status Proxy (`app/api/whatsapp/status/route.ts`)

No auth needed — this is for the dashboard status indicator.

```typescript
import { getWhatsAppStatus } from '@/lib/wgs-client';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const status = await getWhatsAppStatus();
    return NextResponse.json(status);
  } catch {
    return NextResponse.json(
      { status: 'UNREACHABLE' },
      { status: 502 },
    );
  }
}
```

### 2.2 QR Code for Pairing (`app/api/whatsapp/qr/route.ts`)

Admin only. This is the one-time device pairing step.

```typescript
import { auth } from '@/lib/auth';
import { getQrCode } from '@/lib/wgs-client';
import { NextResponse } from 'next/server';

export async function GET() {
  const session = await auth();
  if (session?.user?.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const qr = await getQrCode();
  return NextResponse.json({ qr });
}
```

### 2.3 List Chats (`app/api/whatsapp/chats/route.ts`)

Admin and Team Leads can browse available WhatsApp chats.

```typescript
import { auth } from '@/lib/auth';
import { getChats } from '@/lib/wgs-client';
import { NextResponse } from 'next/server';

export async function GET() {
  const session = await auth();
  if (!session?.user || !['ADMIN', 'TEAM_LEAD'].includes(session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const chats = await getChats();
  return NextResponse.json({ chats });
}
```

### 2.4 Send Message (`app/api/inquiries/[id]/send/route.ts`)

Team Lead sends an approved response via WhatsApp.

```typescript
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendMessage } from '@/lib/wgs-client';
import { NextResponse } from 'next/server';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();

  if (session?.user?.role !== 'TEAM_LEAD') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 1. Load inquiry and verify it belongs to this team lead's team
  const inquiry = await prisma.inquiry.findUnique({
    where: { id },
    include: { drafts: { where: { approved: true }, orderBy: { version: 'desc' }, take: 1 } },
  });

  if (!inquiry || inquiry.teamId !== session.user.teamId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (inquiry.status !== 'IN_REVIEW' && inquiry.status !== 'APPROVED') {
    return NextResponse.json({ error: 'Inquiry not ready to send' }, { status: 400 });
  }

  const draft = inquiry.drafts[0];
  if (!draft) {
    return NextResponse.json({ error: 'No approved draft' }, { status: 400 });
  }

  if (!inquiry.targetJid) {
    return NextResponse.json({ error: 'No target JID set' }, { status: 400 });
  }

  // 2. Send via WGS
  try {
    const msgId = await sendMessage(inquiry.targetJid, draft.content);

    // 3. Update inquiry
    await prisma.inquiry.update({
      where: { id },
      data: {
        status: 'SENT',
        sentMessageId: msgId,
        sentAt: new Date(),
      },
    });

    // 4. Log status change
    await prisma.statusChange.create({
      data: {
        inquiryId: id,
        fromStatus: inquiry.status,
        toStatus: 'SENT',
        changedBy: session.user.id,
      },
    });

    return NextResponse.json({ success: true, msgId });
  } catch (err) {
    // Mark as FAILED so the team lead can retry
    await prisma.inquiry.update({
      where: { id },
      data: { status: 'FAILED' },
    });

    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Send failed' },
      { status: 502 },
    );
  }
}
```

---

## 3. Receiving Webhooks from WGS (`app/api/webhook/whatsapp/route.ts`)

WGS sends two types of POST requests to your app:
- **Heartbeat** — periodic health check (every 5 minutes)
- **Inbound message** — a WhatsApp message from an allowed contact

```typescript
import { NextResponse } from 'next/server';

const WGS_WEBHOOK_SECRET = process.env.WGS_WEBHOOK_SECRET!;

export async function POST(request: Request) {
  // 1. Validate the shared secret
  const apiKey = request.headers.get('x-api-key');
  if (apiKey !== WGS_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();

  // 2. Handle heartbeat
  if (body.type === 'heartbeat') {
    // Optionally cache WGS status in your DB or a global store
    console.log('[WGS Heartbeat]', body.status, 'uptime:', body.uptime);
    return NextResponse.json({ ok: true });
  }

  // 3. Handle inbound message
  //    body shape: { id, from, chatId, text, timestamp, isGroup, pushName }
  //    Use this to track recipient replies, log conversations, etc.
  console.log('[WGS Inbound]', body.from, body.text);

  return NextResponse.json({ ok: true });
}
```

---

## 4. UI Components

### 4.1 WhatsApp Status Indicator

```tsx
'use client';

import { useEffect, useState } from 'react';

export function WhatsAppStatus() {
  const [status, setStatus] = useState<string>('LOADING');

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/whatsapp/status');
        const data = await res.json();
        setStatus(data.status);
      } catch {
        setStatus('UNREACHABLE');
      }
    };

    poll();
    const interval = setInterval(poll, 15_000);
    return () => clearInterval(interval);
  }, []);

  const colors: Record<string, string> = {
    CONNECTED: 'bg-green-500',
    QR_READY: 'bg-yellow-500',
    CONNECTING: 'bg-yellow-500',
    DISCONNECTED: 'bg-red-500',
    ERROR: 'bg-red-500',
    UNREACHABLE: 'bg-gray-500',
    LOADING: 'bg-gray-300',
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2.5 w-2.5 rounded-full ${colors[status] ?? 'bg-gray-300'}`} />
      <span>WhatsApp: {status}</span>
    </div>
  );
}
```

### 4.2 QR Code Scanner (Admin Only)

```tsx
'use client';

import { useEffect, useState } from 'react';

export function QrPairing() {
  const [qr, setQr] = useState<string | null>(null);
  const [message, setMessage] = useState('Loading...');

  useEffect(() => {
    const poll = async () => {
      const res = await fetch('/api/whatsapp/qr');
      const data = await res.json();

      if (data.qr) {
        setQr(data.qr);
        setMessage('Scan this QR code with WhatsApp');
      } else {
        setQr(null);
        setMessage(data.message ?? 'Already connected');
      }
    };

    poll();
    // Poll every 5s because QR refreshes every ~60s
    const interval = setInterval(poll, 5_000);
    return () => clearInterval(interval);
  }, []);

  if (!qr) {
    return <p className="text-sm text-muted-foreground">{message}</p>;
  }

  // Render QR code — install `qrcode.react` package
  // import { QRCodeSVG } from 'qrcode.react';
  // return <QRCodeSVG value={qr} size={256} />;
  return <p className="font-mono text-xs break-all">{qr}</p>;
}
```

### 4.3 Chat Selector

```tsx
'use client';

import { useEffect, useState } from 'react';

interface Chat {
  id: string;
  name: string;
  isGroup: boolean;
}

export function ChatSelector({ value, onChange }: {
  value: string;
  onChange: (jid: string) => void;
}) {
  const [chats, setChats] = useState<Chat[]>([]);

  useEffect(() => {
    fetch('/api/whatsapp/chats')
      .then(r => r.json())
      .then(data => setChats(data.chats ?? []));
  }, []);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border rounded-md p-2"
    >
      <option value="">Select a chat...</option>
      {chats.map((chat) => (
        <option key={chat.id} value={chat.id}>
          {chat.isGroup ? '👥 ' : ''}{chat.name}
        </option>
      ))}
    </select>
  );
}
```

---

## 5. One-Time Setup Flow

```
Step 1: Deploy WGS to Render with all env vars set
Step 2: Deploy Next.js to Vercel with WGS_URL and WGS_API_KEY
Step 3: Admin opens /dashboard/settings → clicks "Pair WhatsApp"
Step 4: QR code appears → admin scans with WhatsApp on their phone
Step 5: Status turns green (CONNECTED) → device is linked
Step 6: WGS persists session to Render Disk — survives redeployments
Step 7: System is ready — team leads can now send messages
```

No further QR scanning needed unless the WhatsApp session is explicitly logged out.
