*Dola Seedream 5.0 pro (hereafter referred to as Seedream 5.0 pro) is designed for high-precision image generation and provides precise control over positions and elements. It supports text-to-image generation, image-to-image generation with one or multiple reference images, interactive editing through coordinates and free-form markings, and decomposing one image into a base image and multiple layers. This tutorial introduces the capabilities exclusive to Seedream 5.0 pro and helps you quickly get started with the Image generation API.
*Featured capabilities
*Seedream 5.0 pro adds the following featured capabilities:

*Capability overview
*The following table compares the capabilities and parameters of each Seedream model version to help you choose the right model based on your business needs.

*Basic usage
*The basic usage of Seedream 5.0 pro, including text-to-image, image-to-image, and multi-image blending, is the same as other Seedream models. Set the model parameter to dola-seedream-5-0-pro-260628. For detailed code examples and instructions, see:
*Text-to-image
*Image-to-image
*Multi-image blending
*Interactive editing
*Seedream 5.0 pro supports specifying edit positions by using bounding boxes, points, arrows, annotation boxes, coordinates, and other methods to precisely generate or modify local areas. For detailed instructions, see Seedream 5.0 pro interactive editing guide.
*Example: Freeform marking
*Use freehand sketches, doodles, circles, or other markings on the reference image to specify the edit region. The model recognizes the marked area and generates or replaces content within it, while blending the result naturally into the original scene.

 
*Example: Coordinate positioning
*Add <point> or <bbox> coordinate tags to the prompt to precisely specify a cross-image edit area and position the subject. For complete steps and parameter descriptions, see Seedream 5.0 pro interactive editing guide.

*Usage instructions
*Interactive editing requires the following inputs: the image to edit and a prompt that contains location information and editing instructions. Depending on the location method, interactive editing supports the following two forms:

*After preparing the inputs, pass the image to edit and the prompt to the API to generate the image editing result.
*Layer decomposition
*Seedream 5.0 pro can automatically decompose subjects, backgrounds, text, decorative elements, and other content in one input image into one base image and up to 16 independently editable layers. Each layer is a PNG image with an alpha channel. The model also returns the position, stacking order, and content description of each layer, allowing you to move, scale, replace, recolor, and recompose the layers in design tools or frontend canvases.
*Workflow
*The following diagram shows the layer decomposition workflow:
 
*Decompose an image
*Set layer_decomposition to true to enable layer decomposition mode. In this mode, image is required and supports only one input image. prompt is optional and can specify the elements to decompose.
*Prompt tips
*The following prompt methods are recommended:

*Example: Automatically decompose all main elements
*To let the model identify and decompose the main elements automatically, provide the image to decompose and set layer_decomposition to true. With cURL, Java, or Go, omit prompt. The Python and OpenAI SDKs require prompt, so their examples use a general decomposition instruction.

 
*Example: Specify exact regions to decompose
*To precisely specify regions for decomposition, use normalized <bbox> coordinates to locate each element.

 
*About the returned response
*In layer decomposition mode, the data array contains the base image and all generated layers. Download each output through its url, use z_index to distinguish the base image from the layers and determine their stacking order, and use bounding_box and z_index to restore, edit, or recompose the layers.

*Response example:
 
*Use decomposed layers
*After obtaining the base image and layers, you can restore the layers to their original positions or adjust their positions, sizes, and stacking order. You can also edit an individual layer to change an element's color, style, or details.
*Restore and recompose layers
*Process the response as follows:
*Use the object whose z_index is 0 as the canvas background.
*Extract layer objects whose z_index is greater than 0 and sort them in ascending order of z_index.
*Download each layer PNG and place it on the output base image or target canvas according to bounding_box.
*Adjust layer coordinates, dimensions, or stacking order as needed, and render the recomposed image.
*Restore a layer to the output base image
*Use bounding_box.absolute to restore a layer to its original position in the output base image. This field contains the layer's absolute pixel coordinates in the output base image coordinate system, in the format [left, top, right, bottom]:
*left and top: Position of the layer's upper-left corner relative to the upper-left corner of the output base image.
*right and bottom: Position of the layer's lower-right corner relative to the upper-left corner of the output base image.
*Calculate the layer's position and dimensions in the base image as follows. Here, x and y specify the position of the layer's upper-left corner in the base image, while w and h specify the displayed width and height of the layer:
 
*Scale the layer to w × h, and then place it at (x, y) on the base image. When combining multiple layers, stack them in ascending order of z_index.
*Restore a layer to a custom canvas
*Use bounding_box.normalized to restore a layer to a frontend or design-tool canvas of a different size. This field contains the layer's normalized coordinates in the output base image coordinate system and indicates the relative positions of the layer boundaries along the width and height of the output base image, in the format [left, top, right, bottom]:
*left and right: Relative positions of the left and right layer boundaries along the width of the base image.
*top and bottom: Relative positions of the top and bottom layer boundaries along the height of the base image.
*For a target canvas with width W and height H, calculate the layer's position and dimensions as follows. Here, x and y specify the position of the layer's upper-left corner in the target canvas, while w and h specify the displayed width and height of the layer:
 
*Scale the layer to w × h, and then place it at (x, y) on the target canvas. Because normalized coordinates are integers, conversion may introduce rounding errors.
*For the complete definition of bounding_box and coordinate examples, see Image generation API.
*Edit a transparent layer
*Layers returned by layer decomposition are PNG images with alpha channels. You can use an output layer as the input image in another Seedream request to edit it independently, for example, to recolor it, change its style, or add details.
*Note
*To preserve the transparent background in the edited layer, set background to transparent and output_format to png. For restrictions, see Transparent background.

 
*Prompt optimization mode
*Seedream 5.0 pro supports selecting the prompt optimization mode by using the optimize_prompt_options.mode parameter:
*standard (default): Standard mode. This mode produces higher-quality content but takes longer.
*fast: Fast mode. This mode takes less time to generate content, but the result is slightly lower than the standard mode.
*Recommendation
*If your business is sensitive to generation latency, we recommend that you use fast mode to reduce waiting time.
 
*Customize image output specifications
*You can configure the following parameters to control image output specifications:
*size: Specifies the size of the output image.
*response_format: Specifies the return format of the generated image.
*output_format: Specifies the file format of the generated image.
*background: Specifies whether to generate an image with an alpha channel.
*watermark: Specifies whether to add a watermark to the output image.
*Image output size
*The supported values and default value of size differ between image generation and layer decomposition. Select a value based on your scenario.
*Image generation
*The following size specification methods are supported. Do not use the two methods at the same time.
*Method 1: Specify a resolution tier (recommended)
*Use natural language in the prompt to describe the image aspect ratio, image shape, or image purpose. The model then determines the final image size.
*Default value: 2K
*Valid values: 1K, 1.5K, 2K
*Note
*1.5K has the same price as 1K and provides better image generation quality.
*When you use Method 1 and describe a specific aspect ratio in the prompt, the actual width and height values mapped by the model are shown in the following table. The model supports more aspect ratios than the standard values listed here. The following table uses common aspect ratios only as examples.

*Method 2: Specify width and height in pixels (widthxheight)
*Total pixel range: [1280x720 (921600), 2048x2048x1.1025 (4624220)]
*Aspect ratio range: [1/16, 16]
*Width and height examples
*When you use Method 2, both the total pixel range and the aspect ratio range must be met. Total pixels refer to the product of the width and height of a single image, not a separate limit on width or height.
*Valid example: 2048x1024
*The total pixel value is 2048x1024=2097152, which falls within [921600, 4624220]. The aspect ratio is 2048/1024=2, which falls within [1/16, 16]. Therefore, this value is valid.
*Invalid example: 512x512
*The total pixel value is 512x512=262144, which is below the minimum value of 921600. Therefore, this value is invalid.

*Layer decomposition
*Only resolution tiers are supported. The output resolution follows these rules:
*Base image: The output base image uses the resolution specified by size and keeps the aspect ratio of the original image.
*Layers: Each output layer uses a resolution close to the value specified by size and keeps the aspect ratio of its corresponding region in the original image.
*Default and valid values:
*Default: auto
*Valid values: 1K, 1.5K, 2K, and auto. With auto, the model determines the output dimensions based on the input dimensions and aspect ratio.
*Note
*1.5K has the same price as 1K and provides better image generation quality.
*auto adaptation rules
*In auto mode, the model determines the dimensions of the output base image and each layer based on the input image dimensions:
*If the input image is between [1280x720 (921,600), 2048x2048x1.1025 (4,624,220)] pixels, the base image and layers are output at the original input dimensions. Each output keeps its aspect ratio in the original image.
*If the input image is smaller than 1K, the base image and layers are output at 1K. Each output keeps its aspect ratio in the original image.
*If the input image is larger than 2K, the base image and layers are output at 2K. Each output keeps its aspect ratio in the original image.
*For common width and height mappings, see the resolution mapping table for image generation.
*Image output method
*Set response_format to specify how generated image data is returned:
*url: Returns an image download URL.
*b64_json: Returns image data as a Base64-encoded string in JSON format.
 
*Image file format
*Set output_format to specify the generated image file format:
*png
*jpeg
 
*warning
*In layer decomposition, output_format controls only the base image format. Layers are always returned in png format.
*Transparent background
*Set background to control whether the generated image has an alpha channel:
*transparent: Generates an image with a transparent background.
*opaque (default): Generates an image with a standard, opaque background.
 
*Usage restrictions
*This parameter is supported only for image-to-image generation with exactly one input image that has an alpha channel.
*In transparent background mode, the output format defaults to png. If output_format is set to jpeg, the request returns an error.
*If the input image uses a format that does not support an alpha channel, such as jpeg, the request returns an error.
*Add a watermark to images
*Use watermark to control whether to add a watermark to the generated image.
*false: Do not add a watermark.
*true: Add an "AI-generated" watermark in the lower-right corner of the image.
 
*Limits
*SDK version upgrade
*To ensure that the model works properly, upgrade to the latest SDK version. For more information, see Install and upgrade SDK.
*Image input limits
*The following image input methods apply to both image generation and layer decomposition:
*Image URL: Make sure that the image URL is accessible.
*Example: https://ark-doc.tos-ap-southeast-1.bytepluses.com/doc_image/seedream4_5_imageToimage.png
*Base64 encoding: Use data:image/<image_format>;base64,<base64_image>. <image_format> must be lowercase, for example, data:image/png;base64,<base64_image>.
*You can use a third-party tool such as https://base64.guru/converter/encode/image to encode an image.
*Input image constraints differ by scenario:

*Note
*The total pixel limit applies to the product of the width and height of a single image, not to either dimension separately.
*Retention period
*Image URLs are retained for only 24 hours. They are automatically cleared after they expire. Save generated images in time.
*Rate limit
*IPM rate limit: The maximum number of images that can be generated per minute for the same model version under an account. If this limit is exceeded, image generation returns an error.
*For layer decomposition, each request initially deducts 17 IPM, reserving quota for the maximum output of one base image and 16 layers. After generation is complete, quota deducted beyond the actual number of generated images is returned.
*Limits vary by model. For more information, see Image generation capabilities.

*curl https://ark.ap-southeast.bytepluses.com/api/v3/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $ARK_API_KEY" \\
  -d '{
    "model": "dola-seedream-5-0-pro-260628\*import os

# Install SDK:  pip install 'byteplus-python-sdk-v2[ark]'
from byteplussdkarkruntime import Ark

client = Ark(
    # The base URL for model invocation
    base_url="https://ark.ap-southeast.bytepluses.com/api/v3\     
*import os
from openai import OpenAI

client = OpenAI(
    # The base URL for model invocation
    base_url="https://ark.ap-southeast.bytepluses.com/api/v3\*import os

# Install SDK:  pip install 'byteplus-python-sdk-v2[ark]'
from byteplussdkarkruntime import Ark

client = Ark(
    # The base URL for model invocation
    base_url="https://ark.ap-southeast.bytepluses.com/api/v3\*{
  "background": "transparent"
}
*curl https://ark.ap-southeast.bytepluses.com/api/v3/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $ARK_API_KEY" \\
  -d '{
    "model": "dola-seedream-5-0-pro-260628\     
* 
     
* 
*package main

import (
    "context"
    "fmt"
    "os"

    "github.com/byteplus-sdk/byteplus-go-sdk-v2/service/arkruntime"
    "github.com/byteplus-sdk/byteplus-go-sdk-v2/service/arkruntime/model"
    "github.com/byteplus-sdk/byteplus-go-sdk-v2/byteplus"
)

func main() {
    client := arkruntime.NewClientWithApiKey(
        os.Getenv("ARK_API_KEY"),
        // The base URL for model invocation
        arkruntime.WithBaseUrl("https://ark.ap-southeast.bytepluses.com/api/v3"),
    )
    ctx := context.Background()

    generateReq := model.GenerateImagesRequest{
        Model:              "dola-seedream-5-0-pro-260628\* 
*import os
from openai import OpenAI

client = OpenAI(
    # The base URL for model invocation
    base_url="https://ark.ap-southeast.bytepluses.com/api/v3\* 
*import os

# Install SDK:  pip install 'byteplus-python-sdk-v2[ark]'
from byteplussdkarkruntime import Ark

client = Ark(
    # The base URL for model invocation
    base_url="https://ark.ap-southeast.bytepluses.com/api/v3\*package com.ark.sample;

import com.byteplus.ark.runtime.model.images.generation.*;
import com.byteplus.ark.runtime.service.ArkService;
import okhttp3.ConnectionPool;
import okhttp3.Dispatcher;

import java.util.concurrent.TimeUnit;

public class ImageGenerationsExample {
    public static void main(String[] args) {
        String apiKey = System.getenv("ARK_API_KEY");
        ConnectionPool connectionPool = new ConnectionPool(5, 1, TimeUnit.SECONDS);
        Dispatcher dispatcher = new Dispatcher();
        ArkService service = ArkService.builder()
                .baseUrl("https://ark.ap-southeast.bytepluses.com/api/v3") // The base URL for model invocation
                .dispatcher(dispatcher)
                .connectionPool(connectionPool)
                .apiKey(apiKey)
                .build();

        GenerateImagesRequest generateRequest = GenerateImagesRequest.builder()
                .model("dola-seedream-5-0-pro-260628") // Replace with Model ID
                .image("https://arkdocs-en.tos-ap-southeast-1.volces.com/images/image-generation/layer_auto.png")
                .size("2K")
                .layerDecomposition(true)
                .responseFormat(ResponseFormat.Url)
                .watermark(false)
                .build();

        ImagesResponse imagesResponse = service.generateImages(generateRequest);
        imagesResponse.getData().forEach(item -> System.out.println(item));

        service.shutdownExecutor();
    }
}
*package main

import (
    "context"
    "fmt"
    "os"

    "github.com/byteplus-sdk/byteplus-go-sdk-v2/service/arkruntime"
    "github.com/byteplus-sdk/byteplus-go-sdk-v2/service/arkruntime/model"
    "github.com/byteplus-sdk/byteplus-go-sdk-v2/byteplus"
)

func main() {
    client := arkruntime.NewClientWithApiKey(
        os.Getenv("ARK_API_KEY"),
        // The base URL for model invocation
        arkruntime.WithBaseUrl("https://ark.ap-southeast.bytepluses.com/api/v3"),
    )
    ctx := context.Background()
    outputFormat := model.OutputFormatPNG

    generateReq := model.GenerateImagesRequest{
        Model:          "dola-seedream-5-0-pro-260628\* 
*package main

import (
    "context"
    "fmt"
    "os"

    "github.com/byteplus-sdk/byteplus-go-sdk-v2/service/arkruntime"
    "github.com/byteplus-sdk/byteplus-go-sdk-v2/service/arkruntime/model"
    "github.com/byteplus-sdk/byteplus-go-sdk-v2/byteplus"
)

func main() {
    client := arkruntime.NewClientWithApiKey(
        os.Getenv("ARK_API_KEY"),
        // The base URL for model invocation
        arkruntime.WithBaseUrl("https://ark.ap-southeast.bytepluses.com/api/v3"),
    )
    ctx := context.Background()
    outputFormat := model.OutputFormatJPEG

    generateReq := model.GenerateImagesRequest{
        Model:              "dola-seedream-5-0-pro-260628\* 
*{
    "prompt": "Add a TV inside the blue box"
}
*{
    "watermark": true
}
* 
* 
* 
*{
    "prompt": "Generate a set of four cohesive illustrations with a 3:2 aspect ratio, centered on the seasonal transformation of the same corner of a courtyard, using a unified style to present the distinct colors, elements, and atmosphere of each season.\*curl https://ark.ap-southeast.bytepluses.com/api/v3/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $ARK_API_KEY" \\
  -d '{
    "model": "dola-seedream-5-0-pro-260628\*x = left
y = top
w = right - left
h = bottom - top
*{
    "output_format": "png"
}
*{
    "prompt": "Generate a series of 4 coherent illustrations focusing on the same corner of a courtyard across the four seasons, presented in a unified style that captures the unique colors, elements, and atmosphere of each season.\* 
* 
* 
* 
*{
    "optimize_prompt_options": {
        "mode": "fast"
    }
}
* 
*import os
from openai import OpenAI

client = OpenAI(
    # The base URL for model invocation
    base_url="https://ark.ap-southeast.bytepluses.com/api/v3\ 
*package com.ark.sample;

import com.byteplus.ark.runtime.model.images.generation.*;
import com.byteplus.ark.runtime.service.ArkService;
import okhttp3.ConnectionPool;
import okhttp3.Dispatcher;

import java.util.concurrent.TimeUnit;

public class ImageGenerationsExample {
    public static void main(String[] args) {
        String apiKey = System.getenv("ARK_API_KEY");
        ConnectionPool connectionPool = new ConnectionPool(5, 1, TimeUnit.SECONDS);
        Dispatcher dispatcher = new Dispatcher();
        ArkService service = ArkService.builder()
                .baseUrl("https://ark.ap-southeast.bytepluses.com/api/v3") // The base URL for model invocation
                .dispatcher(dispatcher)
                .connectionPool(connectionPool)
                .apiKey(apiKey)
                .build();

        GenerateImagesRequest generateRequest = GenerateImagesRequest.builder()
                .model("dola-seedream-5-0-pro-260628") // Replace with Model ID
                .prompt("Perform precise layer separation on the image. The text regions to separate are at <bbox>180 64 812 198</bbox>, <bbox>757 210 939 280</bbox>, <bbox>63 212 320 282</bbox>, <bbox>178 714 826 810</bbox>, <bbox>814 819 949 894</bbox>, and <bbox>326 824 669 930</bbox>; the parrot is at <bbox>347 305 642 997</bbox>.")
                .image("https://arkdocs-en.tos-ap-southeast-1.volces.com/images/image-generation/seedream_50_pro_layer_input.png")
                .layerDecomposition(true)
                .size("2K")
                .outputFormat("jpeg")
                .responseFormat(ResponseFormat.Url)
                .watermark(true)
                .build();

        ImagesResponse imagesResponse = service.generateImages(generateRequest);
        imagesResponse.getData().forEach(item -> System.out.println(item));

        service.shutdownExecutor();
    }
}
*package com.ark.sample;

import com.byteplus.ark.runtime.model.images.generation.*;
import com.byteplus.ark.runtime.service.ArkService;
import okhttp3.ConnectionPool;
import okhttp3.Dispatcher;

import java.util.concurrent.TimeUnit;

public class ImageGenerationsExample {
    public static void main(String[] args) {
        String apiKey = System.getenv("ARK_API_KEY");
        ConnectionPool connectionPool = new ConnectionPool(5, 1, TimeUnit.SECONDS);
        Dispatcher dispatcher = new Dispatcher();
        ArkService service = ArkService.builder()
                .baseUrl("https://ark.ap-southeast.bytepluses.com/api/v3") // The base URL for model invocation
                .dispatcher(dispatcher)
                .connectionPool(connectionPool)
                .apiKey(apiKey)
                .build();

        GenerateImagesRequest generateRequest = GenerateImagesRequest.builder()
                .model("dola-seedream-5-0-pro-260628") // Replace with Model ID
                .prompt("Edit the image based on the hand-drawn sketch. Add a stack of realistic magazines or art books in the marked area at the lower left, and add a ceramic cup of coffee with a saucer in the marked area on the right. Remove all sketch lines. Keep the composition unchanged. Let the newly added objects blend naturally into the original scene.")
                .image("https://arkdocs-en.tos-ap-southeast-1.volces.com/images/image-generation/seedream_50_pro_input2.png")
                .size("2K")
                .outputFormat("png")
                .responseFormat(ResponseFormat.Url)
                .watermark(false)
                .build();

        ImagesResponse imagesResponse = service.generateImages(generateRequest);
        System.out.println(imagesResponse.getData().get(0).getUrl());

        service.shutdownExecutor();
    }
}
* 
* 
*{
  "model": "dola-seedream-5-0-pro-260628\*curl https://ark.ap-southeast.bytepluses.com/api/v3/images/generations \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $ARK_API_KEY" \\
  -d '{
    "model": "dola-seedream-5-0-pro-260628\*Text-to-image
*✓

*✓
*✓
*✓
*1792x1344
*4:3

*Single-image or multi-image input with batch output
*✓

*✓
*✓
*Not supported yet
*[196, 6000×6000 (36,000,000)]
*[512×512 (262,144), 6000×6000 (36,000,000)]
*Total pixels (width × height)
*Prompt
*Input image
*Output

* 

* 

*Up to 10 reference images
*Exactly one image
*Number of input images

* 

*Layers
*bounding_box.normalized
*Normalized position of the layer in the output base image coordinate system. Use it to restore the layer to a custom canvas of any size.
*832x1248
*2:3

* 

*Generation limit

*Number of reference images + number of generated images <= 15
*Supports generating one image or multiple layers (one base image and up to 16 layers)
*Greater than 14
*Not applicable
*Width and height (px)
*1776x2368
*3:4

*1872x1248
*3:2

*IPM rate limit (images/minute)
*500

*500
*500
*500
*Returned for
*Field
*Description
*2352x1008
*21:9

* 

*1344x1792
*3:4

*Image generation
*Layer decomposition
*Constraint
*Layer decomposition
*✗

*✗
*✗
*✓
* 
* 
*Change the parrot in the image into a peacock.
*[1/16, 16]
*[1/16, 16]
*Aspect ratio (width / height)
*Specify elements to decompose
*Describe the elements in natural language, for example, "Decompose the person, title text, and decorative icon in the lower-right corner." You can also mark the elements in the input image with doodles or selections to help the model locate them.
*Single-image or multi-image image-to-image
*✓

*✓
*✓
*✓
*Model name
*Seedream 4.0

*Seedream 4.5
*Seedream 5.0 lite
*Seedream 5.0 pro
*2496x1664
*3:2

*1152x864
*4:3

*1152x2048
*9:16

* 
* 
* 
* 
* 
*1248x1872
*2:3

*Edit the image based on the hand-drawn sketch. Add a stack of realistic magazines or art books in the marked area at the lower left, and add a ceramic cup of coffee with a saucer in the marked area on the right. Remove all sketch lines. Keep the composition unchanged. Let the newly added objects blend naturally into the original scene.
* 
* 
*Model parameters
*1K, 2K, 4K
*Resolution
*2K, 4K
*2K, 3K, 4K
*1K, 1.5K, 2K
*Automatically decompose the main elements
*With cURL, Java, or Go, omit prompt. The model identifies the main subjects, text, background, decorative elements, and other content, and then decomposes them into independent layers. The Python and OpenAI SDKs require prompt; use a general instruction to decompose the main visual elements.

*Base image
*Layers
*One input image (without prompt)

* 

* 

* 
*800x1424
*9:16

*Model ID
*seedream-4-0-250828

*seedream-4-5-251128
*seedream-5-0-260128 (also supports: seedream-5-0-lite-260128)
*dola-seedream-5-0-pro-260628
*Prompt
*Input image
*Output

*jpeg
*Output format
*jpeg
*png, jpeg
*png, jpeg
*Base image and layers
*z_index
*Stacking order. The base image has a fixed value of 0; layers start at 1 and increment in stacking order.
*Streaming output
*✓

*✓
*✓
*Not supported yet
*Base image
*One input image and a prompt with normalized coordinates
*Layers

*Specify exact regions
*Use normalized <bbox> coordinate tags in prompt to specify the regions to decompose. For details about obtaining coordinates, see Seedream 5.0 pro interactive editing guide.
*Layers
*name, description
*Name and semantic description of the layer.
*Method 2
*Method 1
*Natively generate text in 14 additional languages: Russian, Arabic, Filipino, Thai, Turkish, Korean, Malay, Spanish, Portuguese, Indonesian, French, German, Vietnamese, and Japanese.
* 
*Native multilingual generation
*1664x2496
*2:3

*Base image and layers
*url
*Download URL of the base image or layer. The URL is retained for 24 hours.
* 
* 

*Decompose the image into seven layers, including six text groups at:
*<bbox>180 64 812 198</bbox>, <bbox>757 210 939 280</bbox>, <bbox>63 212 320 282</bbox>, <bbox>178 714 826 810</bbox>, <bbox>814 819 949 894</bbox>, and <bbox>326 824 669 930</bbox>;
*and one parrot at <bbox>347 305 642 997</bbox>.
* 
* 
*2368x1776
*4:3

*Layers
*bounding_box.absolute
*Absolute pixel position of the layer in the output base image coordinate system. Use it to restore the layer to its original position in the base image.
*1584x2816
*9:16

*Specify edit positions by using coordinates, bounding boxes, arrows, and other markers for precise operations such as replacing local elements, positioning objects, and generating content in selected regions.
* 
*Interactive editing
*Width and height
*Aspect ratio
*Resolution
*Input layer
*Output
*Prompt
*864x1152
*3:4

*Interactive editing
*✗

*✗
*✗
*✓
*1536x1536
*1:1
*1.5K
*Text-to-image batch output
*✓

*✓
*✓
*Not supported yet
*2048x1152
*16:9

*Description
*Preview
*Featured capability
*1568x672
*21:9

*3136x1344
*21:9

* 

* 

* 
*Up to 30 MB
*Up to 30 MB
*File size
*Automatically decompose subjects, backgrounds, text, decorative elements, and other content in one image into one base image and up to 16 independent layers with alpha channels for further editing, such as moving, scaling, replacing, or recoloring elements.
* 
*Layer decomposition
*Use a tool to frame the coordinates of the content to edit. For information about how to obtain coordinates, see Seedream 5.0 pro interactive editing guide. In the prompt, use <point> or <bbox> coordinate tags to precisely specify the position.
 
*Mark the edit area on the image to edit by using hand-drawn sketches, doodles, circles, or other methods, and then describe the marker position and editing intent in natural language in the prompt.
 

*Standard mode, fast mode
*Prompt optimization mode
*Standard mode
*Standard mode
*Standard mode, fast mode
*1024x1024
*1:1
*1K
*jpeg, png, webp, bmp, tiff, gif, heic, heif
*png, jpeg
*Image format
*Goal
*prompt
*2048x2048
*1:1
*2K
*2816x1584
*16:9

*Place the subject from Image 1 <bbox>179 283 796 986</bbox> at the position in Image 2 <bbox>118 331 933 871</bbox>.
* 
* 
*1424x800
*16:9

* 

* 

* 
* 
* 
*Form 2: Precise coordinate location
*Form 1: Free-form marker + natural-language location
*1248x832
*3:2

*x = left / 1000 × W
y = top / 1000 × H
w = (right - left) / 1000 × W
h = (bottom - top) / 1000 × H
*{
    "response_format": "url"
}
*{
    "prompt": "Place the subject from Image 1 <bbox>179 283 796 986</bbox> at the position in Image 2 <bbox>118 331 933 871</bbox>"
}
