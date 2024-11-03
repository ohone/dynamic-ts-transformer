import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
    const result = await transpileTypescript(`
        const ads = document.querySelector("ads").parentNode;
        ads.parentNode.removeChild(ads);
        const c = document.textContent;
    `, "http://localhost:8080/dev.ts", ["window", "document"], true);
    console.log("--------------------------------");
    console.log(result);
}
//# sourceMappingURL=dev.js.map