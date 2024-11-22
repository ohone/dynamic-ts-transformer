import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
  const i1 = `
    storedTabMap[currentTabId].something = thisProjectId; // this project id
`;

  const result = await transpileTypescript(
    i1,
    "http://localhost:8080/dev.ts",
    ["window", "document"],
    ["sharedState", "config", "background", "IsProxy"],
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
