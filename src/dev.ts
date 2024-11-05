import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await transpileTypescript(
    `
    document.body.firstChild;
    const a = document.body.firstChild;
    document.body.insertBefore(document, document.body.firstChild);
    `,
    "http://localhost:8080/dev.ts",
    ["window", "document"],
    true
  );
  console.log("--------------------------------");
  console.log(result);
}

/*
    const input = document.createElement("input");
    window.addEventListener("message", (event) => {
      const b = input.value;
*/