# WhatsApp Service Integration Guide

Welcome to the official integration guide for the WhatsApp Service. This document acts as the foundation for external applications to connect, authorize, send, and receive messages reliably through the service.

## Table of Contents
1. [Core Concepts](#1-core-concepts)
2. [Authentication](#2-authentication)
3. [Getting Started: Connection Flow](#3-getting-started-connection-flow)
4. [Standard API Responses](#4-standard-api-responses)
5. [Endpoints Reference](#5-endpoints-reference)
   - [Messaging Endpoints](#messaging)
   - [Webhook Configurations](#webhooks-and-events)
6. [Payload Reference](#6-payload-reference)

---

## 1. Core Concepts

*   **Instance / Control Plane:** The global infrastructure hosting the service. Accessed primarily using the `Master Key`.
*   **Client (`clientId`):** Represents an isolated tenant (like a business account or external application).
*   **Device (`deviceId`):** Represents a physical WhatsApp connection session (a scanned QR code). A client can manage multiple devices.
*   **JID vs Phone:** The WhatsApp network targets destinations via `JID` (Jabber ID, formatted like `15551234567@s.whatsapp.net` or `123456789@g.us` for groups). Our service conveniently allows you to post directly using `phone` (E.164 without the `+`, e.g., `15551234567`), which we resolve to a `JID` internally.

---

## 2. Authentication

External applications interact with the API by providing an `x-api-key` header.
- **Client API Key Pattern:** Typically `wa_client_XXXX`. It is generated upon bootstrapping your external application.
- **Master API Key:** Used for Control Plane operations (e.g., creating other clients).

```bash
curl -X GET "https://api.yourdomain.tld/api/v1/clients/:clientId/devices" \
     -H "x-api-key: wa_client_XXXX"
```

---

## 3. Getting Started: Connection Flow

To connect your application to a WhatsApp number, follow this standard provisioning flow:

### Step 1. Bootstrap your Client & Device
Usually done via the Control Plane, you provision a dedicated sandbox:
```bash
POST /api/v1/control-plane/clients/your-tenant-id/bootstrap
# Header: x-api-key: (Master Key)
# Body:
{
  "deviceName": "My Production Device",
  "ttlDays": 90,
  "config": {
    "webhookUrl": "https://your-external-app.com/webhooks/whatsapp"
  }
}
```
*Save the generated `key` from the response. This is your Client API Key for all future steps.*

### Step 2. Get the Device QR Code
To pair a phone, request the QR string and render it (e.g., using `qrcode-terminal` or a web UI):
```bash
GET /api/v1/clients/your-tenant-id/devices/:deviceId/auth/qr
# Header: x-api-key: wa_client_XXXX
```
*Wait for the user to scan the QR code via their WhatsApp App.*

### Step 3. Verify Connection Status
```bash
GET /api/v1/clients/your-tenant-id/devices/:deviceId/status
# Expected Status: "CONNECTED"
```

---

## 4. Standard API Responses

The service envelops **every** operation in a uniform structure:

**Success Response:**
```json
{
  "success": true,
  "timestamp": 1711202800000,
  "data": { ... payload ... }
}
```

**Error Response:**
```json
{
  "success": false,
  "timestamp": 1711202800000,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Provide either jid or phone"
  }
}
```
*Common Error Codes:* `UNAUTHORIZED`, `INVALID_JID`, `DEVICE_NOT_CONNECTED`, `LIMIT_REACHED`.

---

## 5. Endpoints Reference

All specific paths are prefixed with `/api/v1`. 

### Messaging
**Path Route:** `POST /clients/:clientId/devices/:deviceId/messages/<action>`

For any messaging operations, include exactly **ONE** target field: `jid` or `phone`.
Examples:
- `phone: "15551234567"`
- `jid: "15551234567@s.whatsapp.net"`

#### Send Text
`POST .../messages/send-text`
```json
{
  "phone": "15551234567",
  "text": "Hello from the External App!",
  "options": {
    "quotedMessageId": "optional-id",
    "mentionedJids": ["15551234567@s.whatsapp.net"]
  }
}
```

#### Send Image / Video / Audio / Document
`POST .../messages/send-image` (Similarly: `send-video`, `send-audio`, `send-document`)
```json
{
  "phone": "15551234567",
  "caption": "Check out this image!",
  "media": {
    "url": "https://example.com/image.jpg"
  }
}
```
*Note: Your `media` object must provide either a remote `url` or raw `base64` string.*

#### Send Location
`POST .../messages/send-location`
```json
{
  "phone": "15551234567",
  "latitude": 40.7128,
  "longitude": -74.0060,
  "name": "New York City",
  "address": "NY, USA"
}
```

#### Schedule a Message
`POST .../messages/schedule-text`
```json
{
  "phone": "15551234567",
  "text": "Happy Birthday!",
  "sendAt": "2026-04-10T12:00:00Z"
}
```

### Webhooks and Events

Your external app can dynamically receive data when users send messages via Webhooks.

**Configure Webhook Settings:**
`PUT /clients/:clientId/config`
```json
{
  "webhookUrl": "https://your-external-app.com/webhooks/whatsapp",
  "webhookApiKey": "your-secret-signature",
  "events": {
    "messages": true,
    "reactions": true,
    "receipts": false
  }
}
```

**Webhook Delivery Payload Format:**  
When your URL is called, the payload will mirror these types:
```json
{
  "type": "message",
  "deviceId": "uuid",
  "id": "message-id",
  "from": "15551234567@s.whatsapp.net",
  "chatId": "...",
  "messageType": "text", 
  "text": "Hello, I want to buy this!",
  "timestamp": 1711204000
}
```
*Supported Inbound Events:* `message`, `reaction`, `receipt`, `group_participants_update`, `presence_update`, `group_update`, `call`.

---

## 6. Payload Reference

### `MediaSource`
Allows defining media uploads flexibly. Provide exactly one property:
```typescript
{
  "url": "https://.../audio.mp3", // Recommended for large files
  "base64": "data:image/jpeg;base64,/9j/4AAQSkZJ..." // Direct buffers
}
```

### `ServiceStatus` (Device Statuses)
- `INITIALIZING`: App is booting Baileys bindings.
- `QR_READY`: Waiting for the End User to scan via WhatsApp.
- `CONNECTED`: Successfully ready to send/receive.
- `DISCONNECTED`: User removed linked device or session failed.
- `ERROR`: An unrecoverable internal crash happened.
