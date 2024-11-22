import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
    const i1 = `
  
      return (async function() {

  function insertPromptInput() {
    // Create container
    const container = document.createElement("div");
    container.id = "floating-input-container";
    container.style.cssText = \`
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 2147483647;
        background-color: white;
        padding: 10px;
        box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        display: flex;
        justify-content: center;
        align-items: center;
    \`;

    // Create input
    const input = document.createElement("input");
    input.type = "text";
    input.id = "floating-input";
    input.placeholder = "Enter text here...";
    input.style.cssText = \`
        width: 80%;
        max-width: 600px;
        padding: 8px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 14px;
    \`;

    input.addEventListener("keypress", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
            const userPrompt = input.value;
            input.disabled = true;
            handleUserPrompt(userPrompt);
        }
    });

    // Append elements
    container.appendChild(input);
    document.body.insertBefore(container, document.body.firstChild);

    // Adjust page content to prevent overlap
    document.body.style.marginTop =
        container.offsetHeight + parseInt(container.style.padding) * 2 + "px";
}

async function handleAutomaticPrompt(history: PromptedAction[]) {
    const dom = minimizeDOM();
    const systemPrompt = \`You are viewing a webpage described by the dom provided, the user has original command:
    \${history[0].userPrompt}
    dom:
       \`\`\`
        \${dom}
        \`\`\`
        
    in the course of fulfulling the original prompt, you have ALREADY done the following actions:
        \`\`\`
        \${history.map(item => item.responseIntent).join('\n')}
        \`\`\`
    return a json object with two properties, 'code' and 'intent'. 'code' contains javascript that will run in a content script, that performs the next step to fulfil the requested action. 'intent' contains a string describing the desired action that the supplied code should do in pursuit of the users aims.
    return PURE valid json, with objects delimited with double quotes, not markdown-wrapped or with any preamble or summary
        \`;

    console.log(systemPrompt);

    const { action, promptState } = await createAction(history[0].userPrompt, systemPrompt);
    await executeAction(action, promptState);

    // if we're still here, that means we've not navigated away in the action, carry on the loop:
    await handleAutomaticPrompt(promptState);
}

async function executeAction(action: Function, promptState: PromptedAction[]) {
    try {
        await action();
        // if action doesn't result in navigation, prompt for next
        await handleAutomaticPrompt(promptState);
    }
    catch (err) {
        console.error(err);
    }
}

async function handleError(promptState: PromptedAction[], err) {

}

function hydrateUserPrompt(userPrompt: string): string {
    const dom = minimizeDOM();

    const systemPrompt = \`
    You are viewing a webpage described by the DOM provided. The user has command:
        \${userPrompt}
    dom:
        \`\`\`
        \${dom}
        \`\`\`
    return a json object with two properties, 'code' and 'intent'. 'code' contains javascript that will run in a content script, that performs (a step of) the requested action. 'intent' contains a string describing the desired action that the supplied code should do in pursuit of the users aims.
    return pure json, not markdown-wrapped or with any preamble or summary, strings delimited with double quotes
         \`;
    return systemPrompt;
}

async function handleUserPrompt(prompt: string) {

    const systemPrompt = hydrateUserPrompt(prompt);
    console.log(systemPrompt);


    const { action, promptState } = await createAction(prompt, systemPrompt);
    await executeAction(action, promptState);
}

async function createAction(userPrompt: string, fullPrompt: string): Promise<{ action: Function, promptState: PromptedAction[] }> {
    // hit the llm

    const response = await sharedState.AnthropicApi.promptAsync(fullPrompt,
        async (retry, abort) => {
            await new Promise(resolve => setTimeout(resolve, 30000));
            await retry();
        });

    // const response = await sharedState.OpenAi.promptAsync(fullPrompt);
    console.log(response);
    // parse the response
    const parsedResponse = JSON.parse(response) as AgentResponse;

    // bookkeep the response
    const newPromptState = await updatePromptState({ userPrompt, responseIntent: parsedResponse.intent });

    // execute the response
    return { action: new Function(parsedResponse.code), promptState: newPromptState }
}

function minimizeDOM() {
    function isUsefulNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            // Keep non-empty text nodes
            return node.nodeValue?.trim()?.length > 0;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
            // Exclude <script>, <img>, and <style> elements
            const tagName = node.tagName.toLowerCase();
            const excludedTags = [
                "script",
                "img",
                "style",
                "iframe",
                "embed",
                "noscript"
            ];
            return !excludedTags.includes(tagName);
        }
        // Exclude comment nodes
        if (node.nodeType === Node.COMMENT_NODE) {
            return false;
        }
        return false;
    }

    function cloneNodeWithIdAndClass(node) {
        if (!isUsefulNode(node)) {
            return null;
        }

        const newNode = node.cloneNode(false);

        // Retain id, class, and data- attributes
        if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.id) newNode.setAttribute("id", node.id);
            if (node.className) newNode.setAttribute("class", node.className);

            // Retain data- attributes
            for (let i = 0; i < node.attributes.length; i++) {
                let attr = node.attributes[i];
                // if (attr.name.startsWith("data-")) {
                //     newNode.setAttribute(attr.name, attr.value);
                // }
            }
        }

        // Remove all other attributes
        if (newNode.attributes) {
            for (let attr of [...newNode.attributes].reverse()) {
                if (
                    attr.name !== "id" &&
                    attr.name !== "class"
                    //   && !attr.name.startsWith("data-")
                ) {
                    newNode.removeAttribute(attr.name);
                }
            }
        }

        for (let child of node.childNodes) {
            const filteredChild = cloneNodeWithIdAndClass(child);
            if (filteredChild) {
                newNode.appendChild(filteredChild);
            }
        }
        return newNode;
    }

    const minimizedDoc = document.implementation.createHTMLDocument("");
    const minimizedBody = cloneNodeWithIdAndClass(document.body);
    if (minimizedBody) {
        minimizedDoc.body.appendChild(minimizedBody);
    }
    return minimizedDoc.documentElement.outerHTML;
}

type AgentResponse = {
    code: string,
    intent: string
}

type PromptedAction = {
    userPrompt: string;
    responseIntent: string;
}

async function updatePromptState(prompt: PromptedAction): Promise<PromptedAction[]> {
    const currentTabId = ripulConfig.tabId.toString();
    const key = 'promptState_' + currentTabId;
    const promptStateResult = await chrome.storage.local.get([key]);
    const currentPromptState = promptStateResult[key];
    if (currentPromptState && currentPromptState.length > 0) {
        const currentPrompts = currentPromptState as PromptedAction[];
        currentPrompts.push(prompt);
        await chrome.storage.local.set({ [key]: currentPrompts });
        return currentPrompts;
    }
    else {
        await chrome.storage.local.set({ [key]: [prompt] });
        return [prompt];
    }
}

function updatePromptState2(prompt: PromptedAction): Promise<PromptedAction[]> {
    return new Promise((resolve, reject) => {
        const currentTabId = ripulConfig.tabId.toString();
        chrome.storage.local.get([currentTabId], currentPromptState => {
            if (currentPromptState && currentPromptState.length > 0) {
                const currentPrompts = currentPromptState as PromptedAction[];
                currentPrompts.push(prompt);
                chrome.storage.local.set({ [currentTabId]: currentPrompts });
                resolve(currentPrompts)
            }
            else {
                chrome.storage.local.set({ [currentTabId]: [prompt] });
                resolve([prompt]);
            }
        });
    })
}

async function getPromptState() {
    const currentTabId = ripulConfig.tabId.toString();
    const key = 'promptState_' + currentTabId;

    const storage = chrome.storage;
    const local = storage.local;
    const result2 = local.get([key]);
    const result = await chrome.storage.local.get([key]);
    const currentPromptState = result[key];

    if (currentPromptState && currentPromptState.length > 0) {
        return currentPromptState as PromptedAction[];
    }
}

function getPromptState2() {
    return new Promise((resolve, reject) => {
        const currentTabId = ripulConfig.tabId.toString();
        chrome.storage.local.get([currentTabId], currentPromptState => {
            if (currentPromptState && currentPromptState[currentTabId] && currentPromptState[currentTabId].length > 0) {
                resolve(currentPromptState[currentTabId] as PromptedAction[]);
            }
            else {
                resolve();
            }
        });
    });
}

async function updateShouldRunOnTab() {
    const thisProjectId = '70470bc0-9b87-11ef-b18f-0242ac120009';
    const shouldRunOnTabStoreKey = 'shouldRunProjectOnTabs'
    const currentTabId = ripulConfig.tabId.toString();
    const storedTabMap = await chrome.storage.local.get([shouldRunOnTabStoreKey]);
    if (storedTabMap) {
        storedTabMap[currentTabId] = thisProjectId // this project id
        await chrome.storage.local.set({ [shouldRunOnTabStoreKey]: storedTabMap });
    }
    else {
        await chrome.storage.local.set({ [shouldRunOnTabStoreKey]: { [currentTabId]: thisProjectId } });
    }
}

async function updateShouldRunOnTab2() {
    const thisProjectId = '70470bc0-9b87-11ef-b18f-0242ac120009';
    const shouldRunOnTabStoreKey = 'shouldRunProjectOnTabs'
    const currentTabId = ripulConfig.tabId.toString();
    return new Promise((resolve, reject) => {
        chrome.storage.local.get([shouldRunOnTabStoreKey], storedTabMap => {
            if (storedTabMap) {
                storedTabMap[currentTabId] = thisProjectId // this project id
                chrome.storage.local.set({ [shouldRunOnTabStoreKey]: storedTabMap });
            }
            else {
                chrome.storage.local.set({ [shouldRunOnTabStoreKey]: { [currentTabId]: thisProjectId } });
            }
            resolve();
        });
    })

}

//await updateShouldRunOnTab();

const promptState = await getPromptState();
if (promptState) {
    await handleAutomaticPrompt(promptState);
}
else {
    insertPromptInput();
}


  })()
`;
    const result = await transpileTypescript(i1, "http://localhost:8080/dev.ts", ["window", "document", "chrome"], ["sharedState", "config", "background", "IsProxy", "ripulConfig", "console"], false);
    console.log("--------------------------------");
    console.log(result);
}
/*
    const input = document.createElement("input");
    window.addEventListener("message", (event) => {
      const b = input.value;
*/
//# sourceMappingURL=dev.js.map