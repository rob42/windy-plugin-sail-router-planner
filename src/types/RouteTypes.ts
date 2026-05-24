import type { LatLng } from './Coordinates';
import { calculateCourse, calculateGreatCircleDistance, interpolateLatLng } from '../utils/NavigationUtils';

// Available route colors for cycling
const ROUTE_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#FF8C94', '#A8E6CF', '#C7CEEA'];

export interface RouteLeg {
	startTime: number; // timestamp
	startPoint: LatLng;
	endPoint: LatLng;
	course: number; // degrees, 0-359 range
	distance: number; // meters
	averageSpeed: number; // knots
	endTime: number; // timestamp
	duration: number; // milliseconds (endTime - startTime)
}

export class RouteDefinition {
	readonly id: string;
	private _name: string | null; // User-defined name (null = not set by user)
	private _cachedGeoName: string | null; // Auto-generated geo name from API
	private _color: string;
	private _departureTime: number;
	private _defaultSpeed: number;
	private _waypoints: LatLng[] = [];
	private _legSpeeds: number[] = [];
	private _isVisible: boolean = true;
	private _isSaved: boolean = false;
	private _cachedLegs: RouteLeg[] | null = null;
	private _preDepartureOffset: number = 6; // Hours before departure for forecast display
	private _postArrivalOffset: number = 12; // Hours after arrival for forecast display

	constructor(
		id: string | null = null,
		name: string | null = null,
		color: string | null = null,
		departureTime: number | null = null,
		defaultSpeed: number = 7.5
	) {
		this.id = id || crypto.randomUUID();
		this._name = name;
		this._cachedGeoName = null;
		this._color = color || '#FF6B6B';
		this._departureTime = departureTime || Math.floor(Date.now() / (1000 * 60 * 60)) * (1000 * 60 * 60);
		this._defaultSpeed = defaultSpeed;
	}

	addWaypoint(position: LatLng, index: number = -1): void {
		if (index === -1 || index >= this._waypoints.length) {
			// Add to end
			this._waypoints.push(position);
			this._legSpeeds.push(this._defaultSpeed);
		} else {
			// Insert at specific position
			this._waypoints.splice(index, 0, position);
			this._legSpeeds.splice(index, 0, this._defaultSpeed);
		}
		this._clearCache();
		this._clearGeoNameCache();
	}

	removeWaypoint(index: number): void {
		if (index < 0 || index >= this._waypoints.length) {
			throw new Error(`Invalid waypoint index: ${index}`);
		}

		const isFirstOrLast = index === 0 || index === this._waypoints.length - 1;

		this._waypoints.splice(index, 1);
		// Remove corresponding leg speed, but keep at least one if waypoints remain
		if (this._legSpeeds.length > this._waypoints.length) {
			this._legSpeeds.splice(index, 1);
		}
		this._clearCache();

		// Clear geo name cache if first or last waypoint was removed
		if (isFirstOrLast) {
			this._clearGeoNameCache();
		}
	}

	updateWaypoint(index: number, position: LatLng): void {
		if (index < 0 || index >= this._waypoints.length) {
			throw new Error(`Invalid waypoint index: ${index}`);
		}

		const isFirstOrLast = index === 0 || index === this._waypoints.length - 1;
		this._waypoints[index] = position;
		this._clearCache();

		// Clear geo name cache if first or last waypoint was updated
		if (isFirstOrLast) {
			this._clearGeoNameCache();
		}
	}

	setLegSpeed(legIndex: number, speed: number): void {
		const maxLegIndex = Math.max(0, this._waypoints.length - 2);
		if (legIndex < 0 || legIndex > maxLegIndex) {
			throw new Error(`Invalid leg index: ${legIndex}`);
		}
		// Ensure legSpeeds array is large enough
		while (this._legSpeeds.length <= legIndex) {
			this._legSpeeds.push(this._defaultSpeed);
		}
		this._legSpeeds[legIndex] = speed;
		this._clearCache();
	}

	setDepartureTime(departureTime: number): void {
		this._departureTime = departureTime;
		this._clearCache();
	}

	/**
	 * Get the display name - user-defined name takes priority, fallback to geo name
	 */
	get name(): string | null {
		return this._name || this._cachedGeoName;
	}

	/**
	 * Indicates if the route has a user-defined name (as opposed to just a cached geo name)
	 */
	get hasName(): boolean {
		return !!this._name;
	}

	/**
	 * Set user-defined name (e.g., when user renames or saves route)
	 */
	set name(name: string | null) {
		this._name = name;
	}

	get color(): string {
		return this._color;
	}

	set color(color: string) {
		this._color = color;
	}

	/**
	 * Cycle to the next available route color
	 */
	cycleColor(): void {
		const currentIndex = ROUTE_COLORS.indexOf(this._color);
		const nextIndex = (currentIndex + 1) % ROUTE_COLORS.length;
		this._color = ROUTE_COLORS[nextIndex];
	}

	/**
	 * Get all available route colors
	 */
	static getAvailableColors(): string[] {
		return [...ROUTE_COLORS];
	}

	/**
	 * Get a color by index (useful for auto-assigning colors to new routes)
	 */
	static getColorByIndex(index: number): string {
		return ROUTE_COLORS[index % ROUTE_COLORS.length];
	}

	get isVisible(): boolean {
		return this._isVisible;
	}

	set isVisible(visible: boolean) {
		this._isVisible = visible;
	}

	get isSaved(): boolean {
		return this._isSaved;
	}

	set isSaved(saved: boolean) {
		this._isSaved = saved;
	}

	get legs(): RouteLeg[] {
		if (this._cachedLegs === null) {
			this._cachedLegs = this._calculateLegs();
		}
		return [...this._cachedLegs]; // Return copy to prevent mutation
	}

	get waypoints(): LatLng[] {
		return [...this._waypoints]; // Return copy to prevent mutation
	}

	get totalDistance(): number {
		return this.legs.reduce((total, leg) => total + leg.distance, 0);
	}

	get totalDuration(): number {
		return this.legs.reduce((total, leg) => total + (leg.endTime - leg.startTime), 0);
	}

	get departureTime(): number {
		return this._departureTime;
	}

	get arrivalTime(): number {
		return this._departureTime + this.totalDuration;
	}

	getPositionAtTime(timestamp: number): LatLng | null {
		const legs = this.legs;

		// Find which leg contains this timestamp
		for (const leg of legs) {
			if (timestamp >= leg.startTime && timestamp <= leg.endTime) {
				// Calculate progress within this leg (0 to 1)
				const legProgress = (timestamp - leg.startTime) / (leg.endTime - leg.startTime);

				// Interpolate position within the leg using great circle path
				return interpolateLatLng(leg.startPoint, leg.endPoint, legProgress);
			}
		}

		// If before start time, return start point
		if (timestamp < this._departureTime && this._waypoints.length > 0) {
			return this._waypoints[0];
		}

		// If after end time, return end point
		if (this._waypoints.length > 0) {
			return this._waypoints[this._waypoints.length - 1];
		}

		return null;
	}

	duplicate():RouteDefinition {
		// Handle duplicate naming: if name ends with (N), increment to (N+1)
		let duplicatedName = null;
		if (this._name) {
			const match = this._name.match(/^(.+)\((\d+)\)$/);
			if (match) {
				// Name already has (N) format, increment N
				const baseName = match[1];
				const currentNumber = parseInt(match[2], 10);
				duplicatedName = `${baseName}(${currentNumber + 1})`;
			} else {
				// First duplication, add (2)
				duplicatedName = `${this._name}(2)`;
			}
		}

		const duplicatedRoute = new RouteDefinition(
			null, // new ID will be generated
			duplicatedName,
			null,
			this.departureTime,
			this._defaultSpeed
		);

		// Copy waypoints and leg speeds
		this.waypoints.forEach((waypoint:LatLng, index:number) => {
			duplicatedRoute.addWaypoint(waypoint);
		});
		this.legs.forEach((leg:RouteLeg, index:number) => {
			duplicatedRoute.setLegSpeed(index, leg.averageSpeed)
		});

		// Copy other properties
		duplicatedRoute.isVisible = this.isVisible;
		duplicatedRoute.isSaved = false; // New route, not saved yet
		duplicatedRoute.preDepartureOffset = this.preDepartureOffset;
		duplicatedRoute.postArrivalOffset = this.postArrivalOffset;

		return duplicatedRoute;
	}

	private _calculateLegs(): RouteLeg[] {
		const legs: RouteLeg[] = [];

		for (let i = 0; i < this._waypoints.length - 1; i++) {
			const startPoint = this._waypoints[i];
			const endPoint = this._waypoints[i + 1];
			const speed = this._legSpeeds[i];

			if (speed === undefined) {
				throw new Error(`Speed not defined for leg ${i}`);
			}

			// Calculate distance in meters using great circle distance for accuracy
			const distance = calculateGreatCircleDistance(startPoint, endPoint);

			// Calculate course (bearing) in degrees, 0-359 range
			const course = calculateCourse(startPoint, endPoint);

			// Calculate timing (convert meters to nautical miles for speed calculation)
			const distanceNm = distance / 1852; // Convert meters to nautical miles
			const durationHours = distanceNm / speed;
			const durationMs = durationHours * 60 * 60 * 1000;

			const startTime = i === 0 ? this._departureTime : legs[i - 1].endTime;
			const endTime = startTime + durationMs;

			legs.push({
				startTime,
				startPoint,
				endPoint,
				course,
				distance,
				averageSpeed: speed,
				endTime,
				duration: durationMs
			});
		}

		return legs;
	}



	/**
	 * Set the cached geo name (typically called from plugin.svelte after fetching from API)
	 */
	setCachedGeoName(geoName: string | null): void {
		this._cachedGeoName = geoName;
	}

	private _clearCache(): void {
		this._cachedLegs = null;
	}

	private _clearGeoNameCache(): void {
		this._cachedGeoName = null;
	}

	get preDepartureOffset(): number {
		return this._preDepartureOffset;
	}

	set preDepartureOffset(hours: number) {
		this._preDepartureOffset = hours;
	}

	get postArrivalOffset(): number {
		return this._postArrivalOffset;
	}

	set postArrivalOffset(hours: number) {
		this._postArrivalOffset = hours;
	}

}