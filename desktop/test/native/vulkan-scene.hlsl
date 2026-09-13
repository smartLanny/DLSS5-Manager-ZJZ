// Actual geometry for the Vulkan/ReShade input fixture. Depth is written by
// rasterization with normal Z (near 0, far 1); no synthetic ReShade guide textures.
struct DrawConstants { float4 transform; float4 tint; };
[[vk::push_constant]] ConstantBuffer<DrawConstants> draw;
struct VertexOut {
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    float3 tint : TEXCOORD1;
};
VertexOut VSMain(uint id : SV_VertexID) {
    const float2 corners[6] = {
        float2(-1,-1), float2(1,-1), float2(-1,1),
        float2(-1,1), float2(1,-1), float2(1,1)
    };
    VertexOut o;
    o.position = float4(corners[id] * draw.transform.z + draw.transform.xy,
                        draw.transform.w, 1);
    o.uv = corners[id] * 0.5 + 0.5;
    o.tint = draw.tint.rgb;
    return o;
}
float4 PSMain(VertexOut i) : SV_Target0 {
    float checker = fmod(floor(i.uv.x * 18) + floor(i.uv.y * 18), 2);
    float grid = step(0.08, frac(i.uv.x * 18)) * step(0.08, frac(i.uv.y * 18));
    return float4(i.tint * (0.35 + 0.55 * checker) * (0.4 + 0.6 * grid) + 0.025, 1);
}
