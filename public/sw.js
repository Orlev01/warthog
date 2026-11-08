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
  // Open the app where the tap belongs: an approval notification opens straight onto
  // that approval in the inbox; anything else opens Home. Never "/" — that is the public
  // marketing page. (The signed-in guard sends a signed-out person to sign in.)
  event.waitUntil(openApp(targetFor(event.notification.data)));
});

function targetFor(data) {
  if (data && typeof data.approval_id === "string" && data.approval_id.length > 0) {
    return "/inbox?approval=" + encodeURIComponent(data.approval_id);
  }
  return "/home";
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
