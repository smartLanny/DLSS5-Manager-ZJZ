#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include "vulkan-scene-shaders.h"

// Owned scene attachments/pipeline for the bounded test host. The background is
// deliberately drawn last: absent depth testing, it would hide both near quads.
struct VulkanScene {
    VkDevice device{};
    VkPhysicalDeviceMemoryProperties memory{};
    VkExtent2D extent{};
    VkRenderPass renderPass{};
    VkPipelineLayout pipelineLayout{};
    VkPipeline pipeline{};
    VkBuffer readback{};
    VkDeviceMemory readbackMemory{};
    std::vector<VkImage> depthImages;
    std::vector<VkDeviceMemory> depthMemory;
    std::vector<VkImageView> colorViews, depthViews;
    std::vector<VkFramebuffer> framebuffers;
    unsigned readbacks = 0;
    std::uint64_t firstDepthHash = 0, lastDepthHash = 0;
#define SCENE_FUNCTIONS(F) \
    F(CreateImage) F(GetImageMemoryRequirements) F(AllocateMemory) F(BindImageMemory) \
    F(CreateImageView) F(CreateRenderPass) F(CreateFramebuffer) F(CreateShaderModule) \
    F(CreatePipelineLayout) F(CreateGraphicsPipelines) F(CreateBuffer) F(GetBufferMemoryRequirements) \
    F(BindBufferMemory) F(CmdBeginRenderPass) F(CmdBindPipeline) F(CmdPushConstants) F(CmdDraw) \
    F(CmdEndRenderPass) F(CmdPipelineBarrier) F(CmdCopyImageToBuffer) F(MapMemory) F(UnmapMemory) \
    F(DestroyPipeline) F(DestroyPipelineLayout) F(DestroyShaderModule) F(DestroyFramebuffer) \
    F(DestroyRenderPass) F(DestroyImageView) F(DestroyImage) F(FreeMemory) F(DestroyBuffer)
#define DECLARE_SCENE_FUNCTION(name) PFN_vk##name name{};
    SCENE_FUNCTIONS(DECLARE_SCENE_FUNCTION)
#undef DECLARE_SCENE_FUNCTION
    uint32_t memoryType(uint32_t bits, VkMemoryPropertyFlags flags) {
        for (uint32_t i=0;i<memory.memoryTypeCount;++i)
            if ((bits&(1u<<i)) && (memory.memoryTypes[i].propertyFlags&flags)==flags) return i;
        throw std::runtime_error("required scene memory type unavailable");
    }
    void initialize(VkInstance instance, VkPhysicalDevice phys, VkDevice dev,
                    PFN_vkGetInstanceProcAddr gipa, PFN_vkGetDeviceProcAddr gdpa,
                    const std::vector<VkImage>& images, VkExtent2D size, VkFormat colorFormat) {
        device=dev;extent=size;
#define LOAD_SCENE_FUNCTION(name) name=(PFN_vk##name)gdpa(device,"vk" #name);need(name!=nullptr,#name);
        SCENE_FUNCTIONS(LOAD_SCENE_FUNCTION)
#undef LOAD_SCENE_FUNCTION
        auto getMemory=(PFN_vkGetPhysicalDeviceMemoryProperties)gipa(instance,"vkGetPhysicalDeviceMemoryProperties");
        auto getFormat=(PFN_vkGetPhysicalDeviceFormatProperties)gipa(instance,"vkGetPhysicalDeviceFormatProperties");
        need(getMemory&&getFormat,"depth device queries");getMemory(phys,&memory);
        VkFormatProperties supported{};getFormat(phys,VK_FORMAT_D32_SFLOAT,&supported);
        need((supported.optimalTilingFeatures & (VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT|VK_FORMAT_FEATURE_TRANSFER_SRC_BIT)) ==
             (VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT|VK_FORMAT_FEATURE_TRANSFER_SRC_BIT),"D32 depth/transfer support");

        VkAttachmentDescription attachments[2]{};
        attachments[0].format=colorFormat;attachments[0].samples=VK_SAMPLE_COUNT_1_BIT;
        attachments[0].loadOp=VK_ATTACHMENT_LOAD_OP_CLEAR;attachments[0].storeOp=VK_ATTACHMENT_STORE_OP_STORE;
        attachments[0].stencilLoadOp=VK_ATTACHMENT_LOAD_OP_DONT_CARE;attachments[0].stencilStoreOp=VK_ATTACHMENT_STORE_OP_DONT_CARE;
        attachments[0].initialLayout=VK_IMAGE_LAYOUT_UNDEFINED;attachments[0].finalLayout=VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
        attachments[1].format=VK_FORMAT_D32_SFLOAT;attachments[1].samples=VK_SAMPLE_COUNT_1_BIT;
        attachments[1].loadOp=VK_ATTACHMENT_LOAD_OP_CLEAR;attachments[1].storeOp=VK_ATTACHMENT_STORE_OP_STORE;
        attachments[1].stencilLoadOp=VK_ATTACHMENT_LOAD_OP_DONT_CARE;attachments[1].stencilStoreOp=VK_ATTACHMENT_STORE_OP_DONT_CARE;
        attachments[1].initialLayout=VK_IMAGE_LAYOUT_UNDEFINED;attachments[1].finalLayout=VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
        VkAttachmentReference color{0,VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL},depth{1,VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
        VkSubpassDescription sub{};sub.pipelineBindPoint=VK_PIPELINE_BIND_POINT_GRAPHICS;
        sub.colorAttachmentCount=1;sub.pColorAttachments=&color;sub.pDepthStencilAttachment=&depth;
        VkSubpassDependency dependencies[2]{};
        dependencies[0].srcSubpass=VK_SUBPASS_EXTERNAL;dependencies[0].dstSubpass=0;
        dependencies[0].srcStageMask=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT|VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT;
        dependencies[0].dstStageMask=dependencies[0].srcStageMask;
        dependencies[0].dstAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT|VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
        dependencies[1].srcSubpass=0;dependencies[1].dstSubpass=VK_SUBPASS_EXTERNAL;
        dependencies[1].srcStageMask=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT|VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT;
        dependencies[1].dstStageMask=VK_PIPELINE_STAGE_ALL_COMMANDS_BIT;
        dependencies[1].srcAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT|VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
        dependencies[1].dstAccessMask=VK_ACCESS_MEMORY_READ_BIT;
        VkRenderPassCreateInfo rp{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};rp.attachmentCount=2;rp.pAttachments=attachments;
        rp.subpassCount=1;rp.pSubpasses=&sub;rp.dependencyCount=2;rp.pDependencies=dependencies;
        vkcheck(CreateRenderPass(device,&rp,nullptr,&renderPass),"SceneRenderPass");
        for (auto image:images) {
            VkImageCreateInfo di{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};di.imageType=VK_IMAGE_TYPE_2D;di.format=VK_FORMAT_D32_SFLOAT;
            di.extent={extent.width,extent.height,1};di.mipLevels=1;di.arrayLayers=1;di.samples=VK_SAMPLE_COUNT_1_BIT;
            di.tiling=VK_IMAGE_TILING_OPTIMAL;di.usage=VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT|VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
            di.sharingMode=VK_SHARING_MODE_EXCLUSIVE;di.initialLayout=VK_IMAGE_LAYOUT_UNDEFINED;
            VkImage depthImage{};vkcheck(CreateImage(device,&di,nullptr,&depthImage),"SceneDepthImage");depthImages.push_back(depthImage);
            VkMemoryRequirements req{};GetImageMemoryRequirements(device,depthImage,&req);
            VkMemoryAllocateInfo alloc{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};alloc.allocationSize=req.size;
            alloc.memoryTypeIndex=memoryType(req.memoryTypeBits,VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
            VkDeviceMemory allocation{};vkcheck(AllocateMemory(device,&alloc,nullptr,&allocation),"SceneDepthMemory");depthMemory.push_back(allocation);
            vkcheck(BindImageMemory(device,depthImage,allocation,0),"SceneDepthBind");
            VkImageViewCreateInfo view{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};view.image=image;view.viewType=VK_IMAGE_VIEW_TYPE_2D;
            view.format=colorFormat;view.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
            VkImageView cv{},dv{};vkcheck(CreateImageView(device,&view,nullptr,&cv),"SceneColorView");colorViews.push_back(cv);
            view.image=depthImage;view.format=VK_FORMAT_D32_SFLOAT;view.subresourceRange.aspectMask=VK_IMAGE_ASPECT_DEPTH_BIT;
            vkcheck(CreateImageView(device,&view,nullptr,&dv),"SceneDepthView");depthViews.push_back(dv);
            VkImageView views[]{cv,dv};VkFramebufferCreateInfo fb{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};fb.renderPass=renderPass;
            fb.attachmentCount=2;fb.pAttachments=views;fb.width=extent.width;fb.height=extent.height;fb.layers=1;
            VkFramebuffer framebuffer{};vkcheck(CreateFramebuffer(device,&fb,nullptr,&framebuffer),"SceneFramebuffer");framebuffers.push_back(framebuffer);
        }
        VkBufferCreateInfo bc{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};bc.size=VkDeviceSize(extent.width)*extent.height*sizeof(float);
        bc.usage=VK_BUFFER_USAGE_TRANSFER_DST_BIT;bc.sharingMode=VK_SHARING_MODE_EXCLUSIVE;
        vkcheck(CreateBuffer(device,&bc,nullptr,&readback),"SceneDepthReadback");
        VkMemoryRequirements req{};GetBufferMemoryRequirements(device,readback,&req);
        VkMemoryAllocateInfo alloc{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};alloc.allocationSize=req.size;
        alloc.memoryTypeIndex=memoryType(req.memoryTypeBits,VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT|VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
        vkcheck(AllocateMemory(device,&alloc,nullptr,&readbackMemory),"SceneReadbackMemory");
        vkcheck(BindBufferMemory(device,readback,readbackMemory,0),"SceneReadbackBind");

        VkShaderModuleCreateInfo module{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};module.codeSize=sizeof(kVulkanSceneVertex);module.pCode=kVulkanSceneVertex;
        VkShaderModule vs{},ps{};vkcheck(CreateShaderModule(device,&module,nullptr,&vs),"SceneVertexShader");
        module.codeSize=sizeof(kVulkanScenePixel);module.pCode=kVulkanScenePixel;vkcheck(CreateShaderModule(device,&module,nullptr,&ps),"ScenePixelShader");
        VkPipelineShaderStageCreateInfo stages[2]{};stages[0].sType=stages[1].sType=VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
        stages[0].stage=VK_SHADER_STAGE_VERTEX_BIT;stages[0].module=vs;stages[0].pName="VSMain";
        stages[1].stage=VK_SHADER_STAGE_FRAGMENT_BIT;stages[1].module=ps;stages[1].pName="PSMain";
        VkPushConstantRange push{VK_SHADER_STAGE_VERTEX_BIT,0,32};
        VkPipelineLayoutCreateInfo layout{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};layout.pushConstantRangeCount=1;layout.pPushConstantRanges=&push;
        vkcheck(CreatePipelineLayout(device,&layout,nullptr,&pipelineLayout),"ScenePipelineLayout");
        VkPipelineVertexInputStateCreateInfo vi{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
        VkPipelineInputAssemblyStateCreateInfo assembly{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};assembly.topology=VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
        VkViewport viewport{0,0,float(extent.width),float(extent.height),0,1};VkRect2D scissor{{0,0},extent};
        VkPipelineViewportStateCreateInfo vp{VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};vp.viewportCount=1;vp.pViewports=&viewport;vp.scissorCount=1;vp.pScissors=&scissor;
        VkPipelineRasterizationStateCreateInfo raster{VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};raster.polygonMode=VK_POLYGON_MODE_FILL;raster.cullMode=VK_CULL_MODE_NONE;raster.frontFace=VK_FRONT_FACE_COUNTER_CLOCKWISE;raster.lineWidth=1;
        VkPipelineMultisampleStateCreateInfo ms{VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};ms.rasterizationSamples=VK_SAMPLE_COUNT_1_BIT;
        VkPipelineDepthStencilStateCreateInfo ds{VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO};ds.depthTestEnable=VK_TRUE;ds.depthWriteEnable=VK_TRUE;ds.depthCompareOp=VK_COMPARE_OP_LESS;
        VkPipelineColorBlendAttachmentState ba{};ba.colorWriteMask=VK_COLOR_COMPONENT_R_BIT|VK_COLOR_COMPONENT_G_BIT|VK_COLOR_COMPONENT_B_BIT|VK_COLOR_COMPONENT_A_BIT;
        VkPipelineColorBlendStateCreateInfo bs{VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};bs.attachmentCount=1;bs.pAttachments=&ba;
        VkGraphicsPipelineCreateInfo pipelineInfo{VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};pipelineInfo.stageCount=2;pipelineInfo.pStages=stages;
        pipelineInfo.pVertexInputState=&vi;pipelineInfo.pInputAssemblyState=&assembly;pipelineInfo.pViewportState=&vp;
        pipelineInfo.pRasterizationState=&raster;pipelineInfo.pMultisampleState=&ms;pipelineInfo.pDepthStencilState=&ds;
        pipelineInfo.pColorBlendState=&bs;pipelineInfo.layout=pipelineLayout;pipelineInfo.renderPass=renderPass;
        vkcheck(CreateGraphicsPipelines(device,VK_NULL_HANDLE,1,&pipelineInfo,nullptr,&pipeline),"SceneGraphicsPipeline");
        DestroyShaderModule(device,vs,nullptr);DestroyShaderModule(device,ps,nullptr);
    }
    void record(VkCommandBuffer cb,unsigned image,unsigned frame,bool inspect) {
        VkClearValue clear[2]{};clear[0].color={{0.04f,0.06f,0.09f,1}};clear[1].depthStencil={1.0f,0};
        VkRenderPassBeginInfo begin{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};begin.renderPass=renderPass;begin.framebuffer=framebuffers.at(image);
        begin.renderArea={{0,0},extent};begin.clearValueCount=2;begin.pClearValues=clear;
        CmdBeginRenderPass(cb,&begin,VK_SUBPASS_CONTENTS_INLINE);CmdBindPipeline(cb,VK_PIPELINE_BIND_POINT_GRAPHICS,pipeline);
        auto draw=[&](float x,float y,float scale,float z,float r,float g,float b) {
            float constants[8]{x,y,scale,z,r,g,b,1};
            CmdPushConstants(cb,pipelineLayout,VK_SHADER_STAGE_VERTEX_BIT,0,sizeof(constants),constants);CmdDraw(cb,6,1,0,0);
        };
        float time=float(frame)*0.025f;
        draw(std::sin(time)*0.58f,std::cos(time*0.7f)*0.3f,0.25f,0.2f,0.95f,0.3f,0.12f);
        draw(-0.18f,0.1f,0.45f,0.5f,0.12f,0.8f,0.45f);
        draw(0,0,1,0.85f,0.2f,0.35f,0.9f);
        CmdEndRenderPass(cb);
        if (inspect) {
            VkImageMemoryBarrier bar{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};bar.image=depthImages.at(image);
            bar.subresourceRange={VK_IMAGE_ASPECT_DEPTH_BIT,0,1,0,1};bar.srcQueueFamilyIndex=bar.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;
            bar.oldLayout=VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;bar.newLayout=VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
            bar.srcAccessMask=VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;bar.dstAccessMask=VK_ACCESS_TRANSFER_READ_BIT;
            CmdPipelineBarrier(cb,VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT|VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT,VK_PIPELINE_STAGE_TRANSFER_BIT,0,0,nullptr,0,nullptr,1,&bar);
            VkBufferImageCopy copy{};copy.imageSubresource={VK_IMAGE_ASPECT_DEPTH_BIT,0,0,1};copy.imageExtent={extent.width,extent.height,1};
            CmdCopyImageToBuffer(cb,depthImages.at(image),VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,readback,1,&copy);
            std::swap(bar.oldLayout,bar.newLayout);bar.srcAccessMask=VK_ACCESS_TRANSFER_READ_BIT;bar.dstAccessMask=VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
            VkBufferMemoryBarrier host{VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER};host.buffer=readback;host.size=VK_WHOLE_SIZE;
            host.srcQueueFamilyIndex=host.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;host.srcAccessMask=VK_ACCESS_TRANSFER_WRITE_BIT;host.dstAccessMask=VK_ACCESS_HOST_READ_BIT;
            CmdPipelineBarrier(cb,VK_PIPELINE_STAGE_TRANSFER_BIT,VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT|VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT|VK_PIPELINE_STAGE_HOST_BIT,0,0,nullptr,1,&host,1,&bar);
        }
    }
    void inspectDepth(FILE* out,unsigned frame) {
        void* data=nullptr;const size_t pixels=size_t(extent.width)*extent.height;
        vkcheck(MapMemory(device,readbackMemory,0,pixels*sizeof(float),0,&data),"SceneDepthMap");
        float low=1,high=0;size_t nearCount=0,middleCount=0,farCount=0,invalid=0;std::uint64_t hash=1469598103934665603ull;
        const float* values=static_cast<const float*>(data);
        for(size_t i=0;i<pixels;++i) {
            float z=values[i];if(!std::isfinite(z)||z<0||z>1){++invalid;continue;}
            low=std::min(low,z);high=std::max(high,z);
            nearCount+=std::abs(z-0.2f)<0.0001f;middleCount+=std::abs(z-0.5f)<0.0001f;farCount+=std::abs(z-0.85f)<0.0001f;
            std::uint32_t bits=0;std::memcpy(&bits,&z,4);hash=(hash^bits)*1099511628211ull;
        }
        UnmapMemory(device,readbackMemory);if(!readbacks)firstDepthHash=hash;lastDepthHash=hash;++readbacks;
        fprintf(out,"depth_frame=%u depth_min=%.6f depth_max=%.6f near_pixels=%zu middle_pixels=%zu far_pixels=%zu invalid=%zu depth_hash=%016llx\n",
                frame,low,high,nearCount,middleCount,farCount,invalid,static_cast<unsigned long long>(hash));fflush(out);
        need(invalid==0&&nearCount>0&&middleCount>0&&farCount>0,"actual rasterized depth/occlusion readback");
    }
    void destroy() {
        DestroyPipeline(device,pipeline,nullptr);DestroyPipelineLayout(device,pipelineLayout,nullptr);
        for(auto fb:framebuffers)DestroyFramebuffer(device,fb,nullptr);
        DestroyRenderPass(device,renderPass,nullptr);
        for(auto view:colorViews)DestroyImageView(device,view,nullptr);
        for(auto view:depthViews)DestroyImageView(device,view,nullptr);
        for(auto image:depthImages)DestroyImage(device,image,nullptr);
        for(auto mem:depthMemory)FreeMemory(device,mem,nullptr);
        DestroyBuffer(device,readback,nullptr);FreeMemory(device,readbackMemory,nullptr);
    }
};
#undef SCENE_FUNCTIONS
