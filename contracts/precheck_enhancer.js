module.exports = async function enhancePrecheck(precheck) {
    const frames = Number(precheck.frames || 1);
    const x = Number(precheck.res_x || precheck.x || 1920);
    const y = Number(precheck.res_y || precheck.y || 1080);
    const samples = Number(precheck.samples || 128);

    const animation = frames > 1;
    const continuation_possible = animation;
    const cap_possible = animation;

    // Placeholder runtime-estimate (kan förbättras senare)
    const pixel_count = x * y;
    const est_seconds = (pixel_count / 1e6) * samples * (animation ? frames : 1) * 0.002;
    const est_hours = est_seconds / 3600;

    // Define if overlimit is needed
    const OPEN_HOURS = 12;
    const needs_overlimit = est_hours > OPEN_HOURS;

    return {
        frames,
        resolution: [x, y],
        samples,
        animation,
        continuation_possible,
        cap_possible,
        estimated_hours: Number(est_hours.toFixed(2)),
        needs_overlimit
    };
};
