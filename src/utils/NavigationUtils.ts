import type { LatLng } from '../types';

/**
 * Calculate course (bearing) between two points
 */
export function calculateCourse(start: LatLng, end: LatLng): number {
	// Calculate bearing using spherical trigonometry
	const lat1 = start.lat * Math.PI / 180;
	const lat2 = end.lat * Math.PI / 180;
	//allow for 180 deg
	const deltaLon1 = (end.lng - start.lng) * Math.PI / 180;
	const deltaLon2 = ((end.lng+180) + (start.lng-180)) * Math.PI / 180;
	
	const deltaLon = Math.min(deltaLon1,deltaLon2);
	//const deltaLon = (end.lng - start.lng) * Math.PI / 180;

	const y = Math.sin(deltaLon) * Math.cos(lat2);
	const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

	let bearing = Math.atan2(y, x) * 180 / Math.PI;

	// Normalize to 0-359 range
	if (bearing < 0) {
		bearing += 360;
	}

	return bearing;
}

/**
 * Calculate apparent wind from true wind and boat motion
 * Note: Wind speeds should be in the same units (m/s from Windy API, converted to knots in UI)
 */
export function calculateApparentWind(
	trueWindSpeed: number, // m/s from Windy API
	trueWindDirection: number, // degrees - Windy gives wind direction "FROM" (meteorological)
	boatSpeed: number, // m/s (converted from knots in calling code)
	boatCourse: number // degrees
): { speed: number; direction: number } {
	// Convert wind direction FROM meteorological (where it's coming from) to mathematical (where it's going to)
	const windDirectionTo = (trueWindDirection + 180) % 360;

	// Convert degrees to radians
	const twdRad = (windDirectionTo * Math.PI) / 180;
	const courseRad = (boatCourse * Math.PI) / 180;

	// Convert to velocity components (north/east) - now using "going TO" direction
	const trueWindNorth = trueWindSpeed * Math.cos(twdRad);
	const trueWindEast = trueWindSpeed * Math.sin(twdRad);

	// Boat velocity components
	const boatVelocityNorth = boatSpeed * Math.cos(courseRad);
	const boatVelocityEast = boatSpeed * Math.sin(courseRad);

	// Apparent wind = True wind - Boat velocity
	const apparentWindNorth = trueWindNorth - boatVelocityNorth;
	const apparentWindEast = trueWindEast - boatVelocityEast;

	// Calculate apparent wind speed and direction
	const apparentWindSpeed = Math.sqrt(
		apparentWindNorth * apparentWindNorth + apparentWindEast * apparentWindEast
	);

	// Calculate the apparent wind direction (where it's coming FROM)
	let apparentWindDirection = Math.atan2(apparentWindEast, apparentWindNorth) * 180 / Math.PI;

	// Convert to direction wind is coming FROM (add 180)
	apparentWindDirection = (apparentWindDirection + 180) % 360;

	// Calculate relative to boat heading: apparent wind direction - boat course
	// This gives us relative bearing where negative = port side, positive = starboard side
	let relativeWindAngle = apparentWindDirection - boatCourse;

	// Normalize to -179 to 180 range
	while (relativeWindAngle > 180) {
		relativeWindAngle -= 360;
	}
	while (relativeWindAngle <= -180) {
		relativeWindAngle += 360;
	}

	return {
		speed: apparentWindSpeed,
		direction: relativeWindAngle // Now returns relative angle (-179 to 180)
	};
}

/**
 * Calculate relative direction from course (for both wind and wave display)
 * Input: direction FROM (meteorological convention)
 * Output: direction relative to boat heading (-180 to +180, negative=port, positive=starboard)
 */
export function calculateRelativeDirection(directionFrom: number, boatCourse: number): number {
	// Calculate relative direction: wind direction FROM - boat course
	// This gives us the angle where wind is coming FROM relative to boat's heading
	let relativeDirection = directionFrom - boatCourse;

	// Normalize to -180 to +180 range (same as apparent wind calculation)
	while (relativeDirection > 180) {
		relativeDirection -= 360;
	}
	while (relativeDirection <= -180) {
		relativeDirection += 360;
	}

	return relativeDirection;
}



/**
 * Calculate great circle distance between two points in meters
 * Uses the Haversine formula for accurate distance calculation on the sphere
 */
export function calculateGreatCircleDistance(start: LatLng, end: LatLng): number {
	const R = 6371000; // Earth's radius in meters
	const φ1 = start.lat * Math.PI / 180;
	const φ2 = end.lat * Math.PI / 180;
	const Δφ = (end.lat - start.lat) * Math.PI / 180;
	const Δλ = (end.lng - start.lng) * Math.PI / 180;

	const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
			Math.cos(φ1) * Math.cos(φ2) *
			Math.sin(Δλ/2) * Math.sin(Δλ/2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

	return R * c;
}

/**
 * Interpolate position between two points using great circle path
 * For short distances (<100nm), falls back to simple linear interpolation for performance
 */
export function interpolateLatLng(start: LatLng, end: LatLng, progress: number): LatLng {
	// Create LatLng using Leaflet's constructor
	const L = (window as any).L;

	// For short distances, use simple linear interpolation for performance
	const straightLineDistance = Math.sqrt(
		Math.pow(end.lat - start.lat, 2) + Math.pow(end.lng - start.lng, 2)
	);

	if (straightLineDistance < 1.8) { // Roughly 100nm at mid-latitudes
		const lat = start.lat + (end.lat - start.lat) * progress;
		const lng = start.lng + (end.lng - start.lng) * progress;
		return new L.LatLng(lat, lng);
	}

	// For longer distances, use great circle interpolation
	return interpolateGreatCircle(start, end, progress);
}

/**
 * Interpolate position along great circle path between two points
 * Uses spherical interpolation (slerp) for accurate positioning
 */
export function interpolateGreatCircle(start: LatLng, end: LatLng, progress: number): LatLng {
	const L = (window as any).L;

	// Convert to radians
	const φ1 = start.lat * Math.PI / 180;
	const λ1 = start.lng * Math.PI / 180;
	const φ2 = end.lat * Math.PI / 180;
	const λ2 = end.lng * Math.PI / 180;

	// Calculate the angular distance
	const Δφ = φ2 - φ1;
	const Δλ = λ2 - λ1;
	const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
			Math.cos(φ1) * Math.cos(φ2) *
			Math.sin(Δλ/2) * Math.sin(Δλ/2);
	const δ = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

	// Handle edge cases
	if (δ === 0) {
		return new L.LatLng(start.lat, start.lng);
	}

	// Spherical interpolation
	const A = Math.sin((1 - progress) * δ) / Math.sin(δ);
	const B = Math.sin(progress * δ) / Math.sin(δ);

	// Convert to Cartesian coordinates
	const x1 = Math.cos(φ1) * Math.cos(λ1);
	const y1 = Math.cos(φ1) * Math.sin(λ1);
	const z1 = Math.sin(φ1);

	const x2 = Math.cos(φ2) * Math.cos(λ2);
	const y2 = Math.cos(φ2) * Math.sin(λ2);
	const z2 = Math.sin(φ2);

	// Interpolate in Cartesian space
	const x = A * x1 + B * x2;
	const y = A * y1 + B * y2;
	const z = A * z1 + B * z2;

	// Convert back to lat/lng
	const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
	const λ = Math.atan2(y, x);

	const lat = φ * 180 / Math.PI;
	const lng = λ * 180 / Math.PI;

	return new L.LatLng(lat, lng);
}

/**
 * Format coordinates in degrees and decimal minutes format
 * Example: 37°47.123N, 122°25.456W
 */
export function formatCoordinate(degrees: number, isLatitude: boolean, showSeconds: boolean = true): string {
	const hemisphere = isLatitude
		? (degrees >= 0 ? 'N' : 'S')
		: (degrees >= 0 ? 'E' : 'W');

	const abs = Math.abs(degrees);
	const deg = Math.floor(abs);
	const minutes = (abs - deg) * 60;

	if (showSeconds) {
		const minutesFormatted = Math.floor(minutes).toString().padStart(2, '0') + (minutes % 1).toFixed(3).substring(1);
		return `${deg.toString().padStart(2, '0')}°${minutesFormatted}${hemisphere}`;
	} else {
		const minutesRounded = Math.round(minutes).toString().padStart(2, '0');
		return `${deg.toString().padStart(2, '0')}°${minutesRounded}'${hemisphere}`;
	}
}

/**
 * Compute sea comfort index for sailing conditions assessment
 * @param waveHeight Wave height in meters
 * @param wavePeriod Wave period in seconds
 * @param waveDirection Wave direction in degrees (0-360)
 * @param boatSpeed Boat speed in knots
 * @param boatCourse Boat course in degrees (0-360)
 * @returns Sea comfort index (lower = more comfortable)
 */
export function computeSeaIndex(
	waveHeight: number,    // meters
	wavePeriod: number,    // seconds
	waveDirection: number, // true degrees (0-360)
	boatSpeed: number,     // knots
	boatCourse: number     // true degrees (0-360)
): number {
	// --- 1. Relative angle normalized [-180, +180]
	let delta = ((waveDirection - boatCourse + 180) % 360) - 180;
	if (delta < -180) delta += 360; // JS safety

	const rad = delta * Math.PI / 180;

	// --- 2. Wave phase speed (knots)
	const C = 1.56 * wavePeriod;

	// --- 3. Encounter factor (clamped for stability)
	const rawFe = 1 - (boatSpeed / C) * Math.cos(rad);
	const Fe = Math.max(0.3, rawFe);

	// --- 4. Convert m -> ft
	const H_ft = waveHeight * 3.28084;

	// --- 5. Final Sea Index
	const seaIndex = (H_ft / wavePeriod) * Fe;

	return seaIndex;
}