// E05-S04 — Warthog PWA service worker (public/sw.js).
//
// A classic service-worker script: it runs in a ServiceWorkerGlobalScope where
// `self` is the global and handlers are attached with self.addEventListener.
//
// It MUST show a notification for EVERY push. On iOS web push, a push that does
// not result in a user-visible notification can cost the site its push
// permission, so even an empty or malformed payload shows one notification.
// The push payload carries the approval id only — never personal content — so
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
    body: "You have a new request to review.",
    tag: "warthog-push",
  };

  var payload = readPayload(event);
  if (payload && typeof payload.approval_id === "string") {
    // The approval id is not personal content; use it only to coalesce the
    // notification and to route the tap into the app.
    options.tag = "warthog-approval-" + payload.approval_id;
    options.data = { approval_id: payload.approval_id };
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
  // Approvals are only actioned inside the signed-in app, so bring it to front.
  event.waitUntil(focusApp());
});

function focusApp() {
  return self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        var client = windows[i];
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
      return undefined;
    });
}
