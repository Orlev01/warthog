// E05-S04 — Warthog PWA service worker (public/sw.js).
//
// A classic service-worker script: it runs in a ServiceWorkerGlobalScope where
// `self` is the global and handlers are attached with self.addEventListener.
//
// It MUST show a notification for EVERY push. On iOS web push, a push that does
// not result in a user-visible notification can cost the site its push
// permission, so even an empty or malformed payload shows one notification.
// The push payload carries opaque routing ids only — never personal content — so
// the notification body is generic.

self.addEventListener("install", function () {
  // Activate this worker as soon as it is installed, so push works right after
  // the person adds the portal to their home screen.
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  // Take control of already-open pages immediately.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  // Always show exactly one notification, and keep the worker alive until it is
  // shown (iOS drops push permission for a push that shows nothing).
  event.waitUntil(showPushNotification(event));
});

function showPushNotification(event) {
  var title = "Warthog";
  var options = {
    body: "You have a new notification.",
    tag: "warthog-push",
  };

  var payload = readPayload(event);
  var id = approvalId(payload);
  if (id) {
    // The approval id is not personal content; use it only to coalesce the
    // notification and to route the tap into the app.
    options.body = "You have a new request to review.";
    options.tag = "warthog-approval-" + id;
    options.data = { approval_id: id };
  } else if (signInRequest(payload)) {
    // A new device is asking to sign in (no id rides along; the screen lists requests).
    options.body = "A new device is asking to sign in to your account. Only approve it if it's you.";
    options.tag = "warthog-sign-in-request";
    options.data = { kind: "sign-in-requests" };
  } else {
    var record = recordTarget(payload);
    if (record) {
      options.body = "You have a life admin reminder.";
      options.tag = "warthog-record-" + record.recordId;
      options.data = record;
    }
  }

  return self.registration.showNotification(title, options);
}

// Parse the push payload defensively: an empty push has no data, and a
// malformed push throws from json(). Either way return null and still show the
// generic notification.
function readPayload(event) {
  if (!event || !event.data) return null;
  try {
    return event.data.json();
  } catch (err) {
    return null;
  }
}

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  // Open the app where the tap belongs: an approval notification opens straight onto
  // that approval in the inbox; anything else opens Home. Never "/" — that is the public
  // marketing page. (The signed-in guard sends a signed-out person to sign in.)
  event.waitUntil(openApp(targetFor(event.notification.data)));
});

function targetFor(data) {
  var id = approvalId(data);
  if (id) {
    return "/inbox?approval=" + encodeURIComponent(id);
  }
  if (signInRequest(data)) return "/settings/security/sign-in-requests";
  var record = recordTarget(data);
  if (record) return "/life-admin?view=life&tab=" + record.recordTab + "#record-" + record.recordId;
  return "/home";
}

function signInRequest(data) {
  return Boolean(data && data.kind === "sign-in-requests");
}

function recordTarget(data) {
  if (!data || typeof data.recordId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.recordId) ||
      ["subscriptions", "receipts", "renewals"].indexOf(data.recordTab) === -1) return null;
  return { recordId: data.recordId, recordTab: data.recordTab };
}

function approvalId(data) {
  if (!data) return null;
  var id = data.approvalId || data.approval_id;
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : null;
}

// Reuse an open Warthog window when there is one — navigate it to the target, then bring
// it to the front — otherwise open a new window on the target.
function openApp(url) {
  return self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        var client = windows[i];
        if ("navigate" in client && "focus" in client) {
          // navigate() rejects for a window this worker does not control yet; open a
          // fresh window on the target instead of leaving the person where they were.
          return client
            .navigate(url)
            .then(function (navigated) {
              return (navigated || client).focus();
            })
            .catch(function () {
              return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
            });
        }
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    });
}
