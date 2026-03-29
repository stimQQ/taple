use std::time::{Duration, Instant, SystemTime};

mod macos;
pub use macos::*;

#[derive(Clone, Copy, Debug)]
pub enum Timestamp {
    Instant(Instant),
    SystemTime(SystemTime),
    MachAbsoluteTime(MachAbsoluteTimestamp),
}

impl Timestamp {
    pub fn duration_since(&self, start: Timestamps) -> Duration {
        match self {
            Self::Instant(instant) => instant.duration_since(start.instant),
            Self::SystemTime(time) => time.duration_since(start.system_time).unwrap(),
            Self::MachAbsoluteTime(time) => time.duration_since(start.mach_absolute_time),
        }
    }

    pub fn from_cpal(instant: cpal::StreamInstant) -> Self {
        Self::MachAbsoluteTime(MachAbsoluteTimestamp::from_cpal(instant))
    }
}

impl std::ops::Add<Duration> for &Timestamp {
    type Output = Timestamp;

    fn add(self, rhs: Duration) -> Self::Output {
        match *self {
            Timestamp::Instant(i) => Timestamp::Instant(i + rhs),
            Timestamp::SystemTime(t) => Timestamp::SystemTime(t + rhs),
            Timestamp::MachAbsoluteTime(c) => Timestamp::MachAbsoluteTime(c + rhs),
        }
    }
}

impl std::ops::Add<Duration> for Timestamp {
    type Output = Timestamp;

    fn add(self, rhs: Duration) -> Self::Output {
        match self {
            Timestamp::Instant(i) => Timestamp::Instant(i + rhs),
            Timestamp::SystemTime(t) => Timestamp::SystemTime(t + rhs),
            Timestamp::MachAbsoluteTime(c) => Timestamp::MachAbsoluteTime(c + rhs),
        }
    }
}

impl std::ops::Sub<Duration> for Timestamp {
    type Output = Timestamp;

    fn sub(self, rhs: Duration) -> Self::Output {
        match self {
            Timestamp::Instant(i) => Timestamp::Instant(i.checked_sub(rhs).unwrap()),
            Timestamp::SystemTime(t) => Timestamp::SystemTime(t - rhs),
            Timestamp::MachAbsoluteTime(c) => Timestamp::MachAbsoluteTime(c - rhs),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Timestamps {
    instant: Instant,
    system_time: SystemTime,
    mach_absolute_time: MachAbsoluteTimestamp,
}

impl Timestamps {
    pub fn now() -> Self {
        Self {
            instant: Instant::now(),
            system_time: SystemTime::now(),
            mach_absolute_time: MachAbsoluteTimestamp::now(),
        }
    }

    pub fn instant(&self) -> Instant {
        self.instant
    }

    pub fn system_time(&self) -> SystemTime {
        self.system_time
    }

    pub fn mach_absolute_time(&self) -> MachAbsoluteTimestamp {
        self.mach_absolute_time
    }
}
