import {
  DaysOfWeek,
  Holiday,
  IntBool,
  OperatingProfile,
  Service, StopActivity,
  TimingLink,
  TransXChange
} from "./TransXChange";
import {Transform, TransformCallback} from "stream";
import autobind from "autobind-decorator";
import {LocalDate, LocalTime} from "js-joda";
import {ATCOCode} from "../reference/NaPTAN";


/**
 * Transforms TransXChange objects into TransXChangeJourneys that are closer to GTFS calendars, calendar dates, trips
 * and stop times.
 */
@autobind
export class TransXChangeJourneyStream extends Transform {
  private calendars: Record<string, JourneyCalendar> = {};
  private serviceId: number = 1;
  private tripId: number = 1;

  constructor(private readonly holidays: BankHolidays) {
    super({objectMode: true});
  }

  /**
   * Generate a journey
   */
  public _transform(schedule: TransXChange, encoding: string, callback: TransformCallback): void {

    for (const vehicle of schedule.VehicleJourneys) {
      const calendar = this.getCalendar(vehicle.OperatingProfile, schedule.Services[vehicle.ServiceRef]);
      const service = schedule.Services[vehicle.ServiceRef];
      const sectionsRefs = service.StandardService[vehicle.JourneyPatternRef];
      const sections = sectionsRefs.reduce((acc, s) => acc.concat(schedule.JourneySections[s]), [] as TimingLink[]);
      const stopTimes = this.getStopTimes(sections, vehicle.DepartureTime);
      const trip = { id: this.tripId++, headsign: vehicle.VehicleJourneyCode };
      const route = vehicle.ServiceRef;

      this.push({ calendar, stopTimes, trip, route });
    }

    callback();
  }

  private getCalendar(operatingProfile: OperatingProfile, service: Service): JourneyCalendar {
    let startDate = service.OperatingPeriod.StartDate;
    let endDate = service.OperatingPeriod.EndDate;
    let excludes = [];
    let includes = [];

    for (const dates of operatingProfile.SpecialDaysOperation.DaysOfNonOperation) {
      if (dates.StartDate.isEqual(startDate)) {
        startDate = dates.EndDate.plusDays(1);
      }
      else if (dates.EndDate.isEqual(endDate)) {
        endDate = dates.StartDate.minusDays(1);
      }
      else {
        excludes.push(...this.dateRange(dates.StartDate, dates.EndDate));
      }
    }

    for (const holiday of operatingProfile.BankHolidayOperation.DaysOfNonOperation) {
      excludes.push(...this.getHoliday(holiday, startDate));
    }

    for (const holiday of operatingProfile.BankHolidayOperation.DaysOfOperation) {
      includes.push(...this.getHoliday(holiday, startDate));
    }

    const days: DaysOfWeek = operatingProfile.RegularDayType === "HolidaysOnly"
      ? [0, 0, 0, 0, 0, 0, 0]
      : this.mergeDays(operatingProfile.RegularDayType);

    const hash = this.getCalendarHash(days, startDate, endDate, includes, excludes);

    if (!this.calendars[hash]) {
      const id = this.serviceId++;
      this.calendars[hash] = { id, startDate, endDate, days, includes, excludes };
    }

    return this.calendars[hash];
  }

  private mergeDays(daysOfOperation: DaysOfWeek[]): DaysOfWeek {
    return daysOfOperation.reduce(
      (result: DaysOfWeek, days: DaysOfWeek) => result.map((d: IntBool, i: number) => d || days[i]) as DaysOfWeek,
      [0, 0, 0, 0, 0, 0, 0]
    );
  }

  private dateRange(from: LocalDate, to: LocalDate, dates: LocalDate[] = []): LocalDate[] {
    return from.isAfter(to) ? dates : this.dateRange(from.plusDays(1), to, [...dates, from.plusDays(1)]);
  }

  private getHoliday(holiday: Holiday, after: LocalDate): LocalDate[] {
    return this.holidays[holiday].find(dates => dates[0].isAfter(after)) || [];
  }

  private getCalendarHash(days: DaysOfWeek,
                          startDate: LocalDate,
                          endDate: LocalDate,
                          includes: LocalDate[],
                          excludes: LocalDate[]): string {
    return [
      days.join.toString(),
      startDate.toString(),
      endDate.toString(),
      includes.map(d => d.toString()).join(),
      excludes.map(d => d.toString()).join()
    ].join("_");
  }

  private getStopTimes(links: TimingLink[], departureTime: LocalTime): StopTime[] {
    const stops = [{
      stop: links[0].From.StopPointRef,
      arrivalTime: departureTime,
      departureTime: departureTime,
      pickup: true,
      dropoff: false
    }];

    let lastDepartureTime = departureTime;

    for (const link of links) {
      const arrivalTime = lastDepartureTime.plus(link.RunTime);
      lastDepartureTime = link.To.WaitTime ? arrivalTime.plus(link.To.WaitTime) : arrivalTime;

      stops.push({
        stop: link.To.StopPointRef,
        arrivalTime: lastDepartureTime.plus(link.RunTime),
        departureTime: link.To.WaitTime ? arrivalTime.plus(link.To.WaitTime) : lastDepartureTime,
        pickup: link.To.Activity === StopActivity.PickUp || link.To.Activity === StopActivity.PickUpAndSetDown,
        dropoff: link.To.Activity === StopActivity.SetDown || link.To.Activity === StopActivity.PickUpAndSetDown
      });
    }

    return stops;
  }
}

export type BankHolidays = Record<Holiday, LocalDate[][]>;

export interface TransXChangeJourney {
  calendar: JourneyCalendar
  trip: {
    id: number,
    headsign: string,
  }
  route: string,
  stops: StopTime[]
}

export interface JourneyCalendar {
  id: number,
  startDate: LocalDate,
  endDate: LocalDate,
  days: DaysOfWeek,
  includes: LocalDate[],
  excludes: LocalDate[]
}

export interface StopTime {
  stop: ATCOCode,
  arrivalTime: LocalTime,
  departureTime: LocalTime,
  pickup: boolean,
  dropoff: boolean
}