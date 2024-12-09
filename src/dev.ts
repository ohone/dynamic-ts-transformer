import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
  const i1 = `
  (function anonymous(window,self,document,name,location,customElements,history,navigation,locationbar,menubar,personalbar,scrollbars,statusbar,toolbar,status,closed,frames,length,top,opener,parent,frameElement,navigator,origin,external,screen,innerWidth,innerHeight,scrollX,pageXOffset,scrollY,pageYOffset,visualViewport,screenX,screenY,outerWidth,outerHeight,devicePixelRatio,event,clientInformation,screenLeft,screenTop,styleMedia,onsearch,isSecureContext,trustedTypes,performance,onappinstalled,onbeforeinstallprompt,crypto,indexedDB,sessionStorage,localStorage,onbeforexrselect,onabort,onbeforeinput,onbeforematch,onbeforetoggle,onblur,oncancel,oncanplay,oncanplaythrough,onchange,onclick,onclose,oncontentvisibilityautostatechange,oncontextlost,oncontextmenu,oncontextrestored,oncuechange,ondblclick,ondrag,ondragend,ondragenter,ondragleave,ondragover,ondragstart,ondrop,ondurationchange,onemptied,onended,onerror,onfocus,onformdata,oninput,oninvalid,onkeydown,onkeypress,onkeyup,onload,onloadeddata,onloadedmetadata,onloadstart,onmousedown,onmouseenter,onmouseleave,onmousemove,onmouseout,onmouseover,onmouseup,onmousewheel,onpause,onplay,onplaying,onprogress,onratechange,onreset,onresize,onscroll,onsecuritypolicyviolation,onseeked,onseeking,onselect,onslotchange,onstalled,onsubmit,onsuspend,ontimeupdate,ontoggle,onvolumechange,onwaiting,onwebkitanimationend,onwebkitanimationiteration,onwebkitanimationstart,onwebkittransitionend,onwheel,onauxclick,ongotpointercapture,onlostpointercapture,onpointerdown,onpointermove,onpointerrawupdate,onpointerup,onpointercancel,onpointerover,onpointerout,onpointerenter,onpointerleave,onselectstart,onselectionchange,onanimationend,onanimationiteration,onanimationstart,ontransitionrun,ontransitionstart,ontransitionend,ontransitioncancel,onafterprint,onbeforeprint,onbeforeunload,onhashchange,onlanguagechange,onmessage,onmessageerror,onoffline,ononline,onpagehide,onpageshow,onpopstate,onrejectionhandled,onstorage,onunhandledrejection,onunload,crossOriginIsolated,scheduler,alert,atob,blur,btoa,cancelAnimationFrame,cancelIdleCallback,captureEvents,clearInterval,clearTimeout,close,confirm,createImageBitmap,fetch,find,focus,getComputedStyle,getSelection,matchMedia,moveBy,moveTo,open,postMessage,print,prompt,queueMicrotask,releaseEvents,reportError,requestAnimationFrame,requestIdleCallback,resizeBy,resizeTo,scroll,scrollBy,scrollTo,setInterval,setTimeout,stop,structuredClone,webkitCancelAnimationFrame,webkitRequestAnimationFrame,chrome,caches,cookieStore,ondevicemotion,ondeviceorientation,ondeviceorientationabsolute,launchQueue,sharedStorage,documentPictureInPicture,getScreenDetails,queryLocalFonts,showDirectoryPicker,showOpenFilePicker,showSaveFilePicker,originAgentCluster,onpageswap,onpagereveal,credentialless,fence,speechSynthesis,onscrollend,onscrollsnapchange,onscrollsnapchanging,webkitRequestFileSystem,webkitResolveLocalFileSystemURL,sandbox,items,projectConfig,background,observedComponent,executionContext,context,sharedObjects,sharedState,ripulConfig,config,resumeProject,exitProject,getConfig,getFullConfig,asyncIterate,__newFunction
) {
return (async function () {
    async function handleAutomaticPrompt(history: PromptedAction[]) {
        const dom = await background.minimizeDOM(ripulConfig.tabId);
        let responseIntent = '';
        for await (const item of history) {
            responseIntent += await (item.isProxy ? await item["responseIntent"]() : item["responseIntent"]) + '\n';
        }
        responseIntent = responseIntent.slice(0, -1);
        const userPrompt = history[0].userPrompt;
    }
})();})
`;

  const result = await transpileTypescript(
    i1,
    "http://localhost:8080/dev.ts",
    ["window", "document", "chrome"],
    ["sharedState", "config", "background", "IsProxy", "ripulConfig", "console"],
    false
  );

  console.log("--------------------------------");
  console.log(result);
}

/*
    const input = document.createElement("input");
    window.addEventListener("message", (event) => {
      const b = input.value;
*/
