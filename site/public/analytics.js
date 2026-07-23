(() => {
  const dnt = navigator.doNotTrack || window.doNotTrack;
  if (dnt === "1" || dnt === "yes") return;

  try {
    if (localStorage.getItem("plausible_ignore") === "true") return;
  } catch {
    // Storage can be unavailable in hardened browsers; Plausible remains
    // cookieless and collects only the page URL in that case.
  }

  const script = document.createElement("script");
  script.defer = true;
  script.dataset.domain = "cc-analyzer.brnby.com";
  script.src = "https://plausible.brnby.com/js/script.js";
  document.head.append(script);
})();
