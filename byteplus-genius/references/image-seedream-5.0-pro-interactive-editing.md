*Dola Seedream 5.0 pro (hereinafter referred to as seedream-5-0-pro) provides interactive editing capabilities and supports precise image editing by specifying position coordinates in the prompt. You can mark positions on a reference image by using coordinate points or annotations to establish positional relationships. The model then performs edits based on the marked positions, enabling fine-grained operations such as object replacement, element positioning, and partial repainting.
*This document describes how to implement point-based and bounding-box-based interactive editing with Seedream 5.0 pro. After a user uploads a reference image and specifies an edit position by selecting a point or drawing a bounding box, the frontend converts the selected position into normalized coordinates. The coordinate range is 0 to 999, where the top-left corner is 0,0 and the bottom-right corner is 999,999. The frontend then marks the coordinates by using <point> or <bbox> and submits them together with the natural-language prompt to the model. Seedream 5.0 pro generates the edited image based on the reference image, coordinate positions, and text instructions.

*Key step: Convert the target area into normalized coordinates
*The model requires two key inputs: the image to edit and a prompt that contains normalized coordinates and editing instructions. Normalized coordinates map the point or bounding box selected on the image to a 1000 * 1000 proportional coordinate system with values in the range [0,999]. After the image width and height are divided into 1000 units, the top-left corner of the image is 0,0, and the bottom-right corner is 999,999.
*Coordinate formats supported in prompts:
*Point coordinates: <point>x y</point>. This specifies a point, and the model determines the affected area.
*Bounding-box coordinates: <bbox>x1 y1 x2 y2</bbox>. This specifies the top-left and bottom-right coordinates to precisely control the size of the edit area.
*How to process normalized coordinates:
*Obtain the location information: After the user selects a point or draws a bounding box, first obtain the relative coordinates of the point or box within the displayed image area. The coordinates are relative to the top-left corner of the image.
*Point: x_px, y_px, which indicates the click position.
*Bounding box: x1_px, y1_px, x2_px, y2_px, which indicate the top-left and bottom-right corners of the box.
*Convert the coordinates to normalized coordinates in the range 0 to 999: Convert the obtained location coordinates into integer coordinates in the range 0 to 999 based on the displayed width and height of the image.
*Point:
*x = round(x_px / width * 1000)
*y = round(y_px / height * 1000)
*warning
*x and y: The normalized coordinates.
*x_px and y_px: The coordinates of the selected point relative to the top-left corner of the image.
*width and height: The displayed width and height of the image on the canvas.
*Bounding box:
*Convert x1_px, y1_px, x2_px, y2_px by using the same rule to obtain x1 y1 x2 y2.
*Scenarios
*tip
*For information about how to explicitly specify the target object in multi-subject scenarios, see Usage instructions.

*Demo and flow overview
*Demo project
*You can download the code example touch_edit_demo.zip to try interactive editing.
*Flow overview
*The following flowchart shows the complete process for implementing interactive editing based on the code example.
 
*Implementation
*Note
*This document provides code snippets that demonstrate the key logic. The following snippets alone are not sufficient to implement the complete workflow. For the complete implementation, see Demo project.
*0. Upload and place the image on the canvas
*This step is mainly used to obtain the information of the image(s). In this example, the images uploaded by the user are converted into operable objects on the canvas. In addition to saving the image file itself, you must record the position, displayed size, original size of the images, and the total image count. This information provides the basis for subsequent point selection, bounding-box selection, and model calls.
*Key logic
 
*1. Convert the target area into normalized coordinates
*This step converts the point selection or bounding-box selection performed by the user on the canvas into coordinate location markers that can be used in the seedream-5-0-pro prompt.
*How it works
*The area selected by a point or bounding box on the image must be converted into normalized coordinates.
*The coordinate range is 0 to 999, where the top-left corner is 0,0 and the bottom-right corner is 999,999. This explicitly writes the area selected by the user into the prompt. For example:
 
*Types of Coordinate

*Coordinate conversion
*Convert the mouse client coordinates into world coordinates to eliminate the impact caused by canvas position, panning, and zooming.
*Convert the world coordinates into normalized coordinates in the range 0 to 999 within the image. For more information, see Key operation: Convert the target area into normalized coordinates.
*Point selection mode: Generate <point> x y</point>.
*Bounding-box selection mode: Generate <bbox> x1 y1 x2 y2</bbox>.
*Key logic
*Coordinate conversion
 
*Generate <point> or <bbox> coordinate markers based on point selection or bounding-box selection
 
*2. Assemble the prompt
*This step combines the user's natural-language input with the spatial coordinates generated from point selection or bounding-box selection to form the final prompt that seedream-5-0-pro can understand.
*Prompt suggestions

*Key logic
 
*3. Generate an image
*This step calls the Image Generation API based on the assembled prompt and input images, and returns the generated result to the frontend for display.
*Key logic
*The frontend submits an image generation request
 
*The backend calls the image generation API
 
*Output preview

*Tips for specifying the subject
*In multi-subject scenarios, you can use the following approaches to specify the target object more clearly.
*Explicitly specify the target object when a bounding box contains multiple subjects.
*If the area covered by <bbox> contains multiple subjects or elements, we recommend adding a description in the prompt to specify the target object to edit, such as "the person on the left\*Example: Replace the person on the left in Image 1 <bbox>120 180 640 760</bbox> with a robot.
*Mark objects that must remain unchanged.
*If you want some objects to remain unchanged, you can also include them in bounding boxes and explicitly state "keep unchanged" or "do not modify" in the prompt.
*Example: Replace the area Image 1 <bbox>120 180 640 760</bbox> with a garden, and keep the area Image 1 <bbox>700 120 920 360</bbox> unchanged.
*Related documents
*Seedream 5.0 pro tutorial
*Image generation API

*function annotationTokenForLabel(ann, label) {
  if (ann.type === "point") {
    return `${label}<point>${ann.x} ${ann.y}</point>`;
  }
  return `${label}<bbox>${ann.x1} ${ann.y1} ${ann.x2} ${ann.y2}</bbox>`;
}

function buildModelInputFromPrompt() {
  const assignedImages = new Map();
  const inputImages = [];

  function assignImage(image) {
    if (!image) return "";
    if (!assignedImages.has(image.id)) {
      const inputLabel = imageLabel(inputImages.length + 1);
      assignedImages.set(image.id, inputLabel);
      inputImages.push({ ...image, inputLabel });
    }
    return assignedImages.get(image.id);
  }

  function remapImageLabels(text) {
    return text.replace(/Image\\s+\\d+/g, (label) => {
      const image = state.images.find((item) => item.label === label);
      return image ? assignImage(image) : label;
    });
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return remapImageLabels(node.textContent || "");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    if (node.classList?.contains("annotation-inline")) {
      const ann = state.annotations.find((item) => item.id === Number(node.dataset.annotationId));
      const image = ann ? state.images.find((item) => item.id === ann.imageId) : null;
      const inputLabel = assignImage(image);
      if (!ann || !inputLabel) return "";
      return ` ${annotationTokenForLabel(ann, inputLabel)} `;
    }
    if (node.tagName === "BR") {
      return "\
";
    }
    return [...node.childNodes].map(walk).join("");
  }

  const prompt = walk(promptInput)
    .replace(/\ /g, " ")
    .replace(/[ \	]{2,}/g, " ")
    .replace(/\
{3,}/g, "\
\
")
    .trim();

  return { prompt, images: inputImages };
}
*Replace the object at Image 1 <point>520 460</point> with a crown.
Replace the area <bbox>120 180 640 760</bbox> in Image 1 with a garden.
*if (state.mode === "point" && image) {
  const p = normalizedPoint(worldPoint, image);
  const ann = buildAnnotation("point\*generateBtn.addEventListener("click\*import os
from typing import Any

from byteplussdkarkruntime import Ark

DEFAULT_ARK_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3"
DEFAULT_ARK_MODEL = "dola-seedream-5-0-pro-260628"

def _get_ark_client() -> Ark:
    api_key = os.getenv("ARK_API_KEY")
    if not api_key:
        raise RuntimeError("ARK_API_KEY environment variable is not set.")
    return Ark(base_url=os.getenv("ARK_BASE_URL\*function clientToWorld(clientX, clientY) {
  const rect = viewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.view.x) / state.view.scale,
    y: (clientY - rect.top - state.view.y) / state.view.scale,
  };
}

function clamp1000(value) {
  return Math.max(0, Math.min(999, Math.round(value)));
}

function normalizedPoint(worldPoint, image) {
  return {
    x: clamp1000(((worldPoint.x - image.x) / image.width) * 1000),
    y: clamp1000(((worldPoint.y - image.y) / image.height) * 1000),
  };
}

function normalizedBox(a, b, image) {
  const x1 = Math.max(image.x, Math.min(a.x, b.x));
  const y1 = Math.max(image.y, Math.min(a.y, b.y));
  const x2 = Math.min(image.x + image.width, Math.max(a.x, b.x));
  const y2 = Math.min(image.y + image.height, Math.max(a.y, b.y));
  return {
    x1: clamp1000(((x1 - image.x) / image.width) * 1000),
    y1: clamp1000(((y1 - image.y) / image.height) * 1000),
    x2: clamp1000(((x2 - image.x) / image.width) * 1000),
    y2: clamp1000(((y2 - image.y) / image.height) * 1000),
  };
}
*function imageLabel(index) {
  return `Image ${index}`;
}

function addImageFromFile(file, dataUrl) {
  const probe = new Image();
  probe.onload = () => {
    const maxSide = 360;
    const ratio = Math.min(1, maxSide / Math.max(probe.naturalWidth, probe.naturalHeight));
    const id = `img-${state.nextId}`;
    const image = {
      id,
      label: imageLabel(state.nextId),
      name: file.name,
      dataUrl,
      element: probe,
      naturalWidth: probe.naturalWidth,
      naturalHeight: probe.naturalHeight,
      x: 80 + (state.nextId - 1) * 40,
      y: 80 + (state.nextId - 1) * 40,
      width: Math.round(probe.naturalWidth * ratio),
      height: Math.round(probe.naturalHeight * ratio),
    };
    state.nextId += 1;
    state.images.push(image);
    selectImage(id);
    setStatus(`${image.label} uploaded. You can drag it or add point/box annotations.`);
  };
  probe.src = dataUrl;
}
*Point selection and bounding-box
*Place the subject from Image 1 <bbox>179 283 796 986</bbox> at the position of Image 2 <bbox>118 331 933 871</bbox>, and replace the object at Image 2 <point>50 50</point> with a crown.
*Cross-image editing
*Scenario
*Reference format
*Interaction mode
*Prompt
*Scenario
*Usage
*Coordinate type
*Description
* 

*Convert the target area selected by the user into spatial coordinates, and assemble them into a prompt that the model can understand.

*Prompt: Use the subject in Image 2 <bbox>118 331 933 871</bbox> to replace the subject in Image 1 <bbox>179 283 796 986</bbox>.
* 

*Generate the edited image based on the assembled prompt and the reference image.
*Raw input from browser events.
*Client coordinates
*The mouse position relative to the top-left corner of the browser window, i.e., event.clientX / event.clientY.
* 
*Prompt: Use the subject in Image 2 <bbox>118 331 933 871</bbox> to replace the subject in Image 1 <bbox>179 283 796 986</bbox>.
* 
*Point
*Replace the object at <point>520 460</point> in Image 1 with a crown.
*Edit an object near a specified point
*Edit an object near a specified point
*Replace the object at Image 1 <point>520 460</point> with a crown.
*Cross-image editing
*Place the subject from Image 1 <bbox>179 283 796 986</bbox> at the position of Image 2 <bbox>118 331 933 871</bbox>.
*Input image
*Preview
*Edit an object in a specified area
*Replace the area of Image 1 <bbox>120 180 640 760</bbox> with a garden.
*The final coordinates written into <point> or <bbox>.
*Normalized coordinates
*Coordinates normalized to 0 to 999 relative to a single image.
*Input image and bounding-box selection
*Preview
*Ensures that the image can still be correctly selected after the canvas is zoomed or panned.
*World coordinates
*The logical coordinate system inside the canvas. The x / y / width / height values of an image are all stored in this coordinate system.
*Bounding-box
*Replace the area <bbox>120 180 640 760</bbox> in Image 1 with a garden.
*Edit an object in a specified area
