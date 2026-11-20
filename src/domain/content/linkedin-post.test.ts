// A LinkedIn post Warthog builds from an agent's plain fields (src/domain/content/linkedin-post.ts;
// docs/adr/linkedin-connector.md): the text the card shows is exactly the text posted, LinkedIn's
// reserved characters are escaped so nothing is cut short, hashtags still work, and only an
// https link LinkedIn can show is accepted.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LinkedInPostError,
  buildLinkedInPost,
  checkLinkedInPost,
  isLinkedInPostUrn,
  littleText,
  outgoingPost,
  postText,
  postUrl,
} from "./linkedin-post";

test("the posted text is the text the card shows: invisible characters removed, ends trimmed", () => {
  assert.equal(postText("  Hello​ team  \n"), "Hello team");
  assert.equal(postText("Family 👨‍👩‍👧 news"), "Family 👨‍👩‍👧 news", "emoji joiners survive");
});

test("LinkedIn's reserved characters are escaped, so a bracket or star never cuts a post short", () => {
  assert.equal(littleText("Q3 (draft) [v2] *bold* _x_ ~y~ <z> {a|b} @sam \\ done"),
    "Q3 \\(draft\\) \\[v2\\] \\*bold\\* \\_x\\_ \\~y\\~ \\<z\\> \\{a\\|b\\} \\@sam \\\\ done");
});

test("a hashtag stays a hashtag; a lone or numbered # is plain text", () => {
  assert.equal(littleText("Big week #hiring #AI, ranked # 1 and #1"), "Big week #hiring #AI, ranked \\# 1 and \\#1");
  assert.equal(littleText("#café opens"), "#café opens");
});

test("the post body names the person, the visibility and the escaped text", () => {
  const body = buildLinkedInPost("abc-123_X", { text: "Launching (finally)!", visibility: "PUBLIC" });
  assert.deepEqual(body, {
    author: "urn:li:person:abc-123_X",
    commentary: "Launching \\(finally\\)!",
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  });
  assert.equal(buildLinkedInPost("abc", { text: "Hi" }).visibility, "CONNECTIONS", "connections only unless asked");
});

test("a link becomes an article with a title (the site's name when none is given)", () => {
  const body = buildLinkedInPost("abc", { text: "Worth a read", link: { url: "https://www.example.com/post?id=1" } });
  assert.deepEqual(body.content, { article: { source: "https://www.example.com/post?id=1", title: "example.com" } });
  const titled = buildLinkedInPost("abc", { text: "x", link: { url: "https://example.com/a", title: "  Our news​ ", description: "Short" } });
  assert.deepEqual(titled.content, { article: { source: "https://example.com/a", title: "Our news", description: "Short" } });
});

test("only an https link with no sign-in details is accepted", () => {
  for (const url of ["http://example.com", "javascript:alert(1)", "https://user:pw@example.com/", "https://localhost/x", "https://10.0.0.1/", "not a url"]) {
    assert.throws(() => buildLinkedInPost("abc", { text: "x", link: { url } }), LinkedInPostError, url);
  }
});

test("a post needs words, at most LinkedIn's 3,000 characters, and a real member id", () => {
  assert.throws(() => buildLinkedInPost("abc", { text: " ​ " }), LinkedInPostError);
  assert.throws(() => buildLinkedInPost("abc", { text: "x".repeat(3001) }), LinkedInPostError);
  assert.doesNotThrow(() => buildLinkedInPost("abc", { text: "x".repeat(3000) }));
  for (const sub of ["", "a b", "urn:li:person:1", "x".repeat(101)]) {
    assert.throws(() => buildLinkedInPost(sub, { text: "x" }), LinkedInPostError, sub);
  }
});

test("the card summary is what will be posted, with who can see it and where the link goes", () => {
  const summary = outgoingPost({ text: `Hello​ ${"word ".repeat(80)}`, visibility: "PUBLIC", link: { url: "https://www.example.com/a" } });
  assert.equal(summary.kind, "post");
  assert.equal(summary.visibility, "PUBLIC");
  assert.equal(summary.linkDomain, "example.com");
  assert.equal(summary.link, "https://www.example.com/a");
  assert.ok(summary.text.startsWith("Hello word"));
  assert.ok(summary.excerpt.length <= 280 && summary.excerpt.endsWith("…"));
  assert.equal(outgoingPost({ text: "Short" }).visibility, "CONNECTIONS");
});

test("a post id is a share or ugcPost URN, and its link opens the post", () => {
  assert.ok(isLinkedInPostUrn("urn:li:share:6844785523593134080"));
  assert.ok(isLinkedInPostUrn("urn:li:ugcPost:68447855235931240"));
  for (const id of ["urn:li:person:1", "urn:li:share:", "urn:li:share:12/../x", "share:1", "urn:li:share:1 "]) assert.ok(!isLinkedInPostUrn(id), id);
  assert.equal(postUrl("urn:li:share:123"), "https://www.linkedin.com/feed/update/urn:li:share:123/");
});

test("a # inside a web address in the text stays part of the address, not a hashtag", () => {
  assert.equal(littleText("See https://example.com/page#section and #hiring"), "See https://example.com/page\\#section and #hiring");
});

test("the escaped text must fit LinkedIn's limit too", () => {
  assert.throws(() => buildLinkedInPost("abc", { text: "(".repeat(2000) + "x".repeat(999) }), LinkedInPostError);
  assert.doesNotThrow(() => buildLinkedInPost("abc", { text: "x".repeat(3000) }));
});

test("checkLinkedInPost refuses what Warthog won't post, in words an agent can act on", () => {
  assert.throws(() => checkLinkedInPost({ text: "Hi", link: { url: "http://example.com" } }), /https/);
  assert.throws(() => checkLinkedInPost({ text: "​" }), /some text/);
  assert.doesNotThrow(() => checkLinkedInPost({ text: "Hi", link: { url: "https://example.com", title: "A" } }));
});
