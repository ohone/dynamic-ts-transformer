import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
    const i1 = `
      return (async function() {
        // Create container
        const container = document.something.createElement('div');
})`;
    const input = `function isUsefulNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            // Keep non-empty text nodes
            return node.nodeValue.trim().length > 0;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
            // Exclude <script>, <img>, and <style> elements
            const tagName = node.tagName.toLowerCase();
            const excludedTags = ['script', 'img', 'style', 'iframe', 'embed', 'button', 'input'];
            return !excludedTags.includes(tagName);
        }
        // Exclude comment nodes
        if (node.nodeType === Node.COMMENT_NODE) {
            return false;
        }
        return false;
    }`;
    const fullInput = `
//
//

    return (async function() {
    // Create container
const container = document.createElement('div');
container.id = 'floating-input-container';
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
const input = document.createElement('input');
input.type = 'text';
input.id = 'floating-input';
input.placeholder = 'Enter text here...';
input.style.cssText = \`
        width: 80%;
        max-width: 600px;
        padding: 8px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 14px;
    \`;

input.addEventListener('keypress', async (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    // Create and dispatch custom event with input value
    const searchTerm = input.value;

    const event = new CustomEvent('chatgpt_prompt', {
        detail: searchTerm 
    });

    const myWindow = window;
    myWindow.dispatchEvent(event);
    
    const systemPrompt = ''
    const dom = minimizeDOM();


    console.log(dom);
    
    // Clear input after dispatch
    input.value = '';
  }
});

// Append elements
container.appendChild(input);
document.body.insertBefore(container, document.body.firstChild);

// Adjust page content to prevent overlap
document.body.style.marginTop =
    (container.offsetHeight + parseInt(container.style.padding) * 2) + 'px';

function minimizeDOM() {
    function isUsefulNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            // Keep non-empty text nodes
            return node.nodeValue.trim().length > 0;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
            // Exclude <script>, <img>, and <style> elements
            const tagName = node.tagName.toLowerCase();
            const excludedTags = ['script', 'img', 'style', 'iframe', 'embed', 'button', 'input'];
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
            if (node.id) newNode.setAttribute('id', node.id);
            if (node.className) newNode.setAttribute('class', node.className);

            // Retain data- attributes
            for (let i = 0; i < node.attributes.length; i++) {
                let attr = node.attributes[i];
                if (attr.name.startsWith('data-')) {
                    newNode.setAttribute(attr.name, attr.value);
                }
            }
        }

        // Remove all other attributes
        if (newNode.attributes) {
            for (let attr of [...newNode.attributes]) {
                if (attr.name !== 'id' && attr.name !== 'class' && !attr.name.startsWith('data-')) {
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


    const minimizedDoc = document.implementation.createHTMLDocument('');
    const minimizedBody = cloneNodeWithIdAndClass(document.body);
    if (minimizedBody) {
        minimizedDoc.body.appendChild(minimizedBody);
    }
    return minimizedDoc.documentElement.outerHTML;
}
  })()
    `;
    const result = await transpileTypescript(i1, "http://localhost:8080/dev.ts", ["window", "document"], true);
    console.log("--------------------------------");
    console.log(result);
}
/*
    const input = document.createElement("input");
    window.addEventListener("message", (event) => {
      const b = input.value;
*/
//# sourceMappingURL=dev.js.map