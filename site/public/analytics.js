(() => {
  const PLAUSIBLE_ORIGIN = "https://plausible.brnby.com";
  // Opaque site tracker id from Plausible's installation snippet. Update this
  // value if the tracker configuration is regenerated in Plausible.
  const PLAUSIBLE_TRACKER_ID = "pa-ngd1ppRBUHfoOrHRCjEei";

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
  script.src = `${PLAUSIBLE_ORIGIN}/js/${PLAUSIBLE_TRACKER_ID}.js`;
  document.head.append(script);
  plausible.init();
})();
