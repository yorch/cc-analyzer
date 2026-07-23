(() => {
  const dnt = navigator.doNotTrack || window.doNotTrack;
  if (dnt === "1" || dnt === "yes") return;

  try {
    if (localStorage.getItem("plausible_ignore") === "true") return;
  } catch {
    // Storage can be unavailable in hardened browsers; Plausible remains
    // cookieless and collects only the page URL in that case.
  }

  const plausible =
    window.plausible ||
    function () {
      (plausible.q = plausible.q || []).push(arguments);
    };
  window.plausible = plausible;
  plausible.init =
    plausible.init ||
    function (options) {
      plausible.o = options || {};
    };

  const script = document.createElement("script");
  script.async = true;
  script.src = "https://plausible.brnby.com/js/pa-ngd1ppRBUHfoOrHRCjEei.js";
  document.head.append(script);
  plausible.init();
})();
