use crate::settings::FloatingAssistantPosition;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LogicalScreenBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn default_floating_position(
    screen_width: f64,
    screen_height: f64,
    pet_size: f64,
    inset: f64,
) -> FloatingAssistantPosition {
    clamp_floating_position(
        FloatingAssistantPosition {
            x: screen_width - pet_size - inset,
            y: (screen_height - pet_size) / 2.0,
        },
        screen_width,
        screen_height,
        pet_size,
        pet_size,
        inset,
    )
}

pub fn clamp_floating_position(
    position: FloatingAssistantPosition,
    screen_width: f64,
    screen_height: f64,
    window_width: f64,
    window_height: f64,
    inset: f64,
) -> FloatingAssistantPosition {
    FloatingAssistantPosition {
        x: clamp_axis(position.x, screen_width, window_width, inset),
        y: clamp_axis(position.y, screen_height, window_height, inset),
    }
}

pub fn monitor_bounds_containing_position(
    position: FloatingAssistantPosition,
    monitors: &[LogicalScreenBounds],
) -> Option<LogicalScreenBounds> {
    monitors.iter().copied().find(|bounds| {
        position.x >= bounds.x
            && position.x < bounds.x + bounds.width
            && position.y >= bounds.y
            && position.y < bounds.y + bounds.height
    })
}

pub fn expanded_floating_position(
    anchor: FloatingAssistantPosition,
    screen: LogicalScreenBounds,
    window_width: f64,
    window_height: f64,
    inset: f64,
) -> FloatingAssistantPosition {
    clamp_position_to_bounds(anchor, screen, window_width, window_height, inset)
}

pub fn fit_window_size_to_bounds(
    window_width: f64,
    window_height: f64,
    screen: LogicalScreenBounds,
    inset: f64,
) -> (f64, f64) {
    let maximum_width = (screen.width - inset * 2.0).max(1.0);
    let maximum_height = (screen.height - inset * 2.0).max(1.0);
    (
        window_width.clamp(1.0, maximum_width),
        window_height.clamp(1.0, maximum_height),
    )
}

pub fn launcher_floating_position(
    anchor: FloatingAssistantPosition,
    screen: LogicalScreenBounds,
    launcher_width: f64,
    launcher_height: f64,
    pet_size: f64,
    inset: f64,
) -> FloatingAssistantPosition {
    let screen_right = screen.x + screen.width - inset;
    let x = if anchor.x + launcher_width > screen_right {
        anchor.x - (launcher_width - pet_size)
    } else {
        anchor.x
    };
    clamp_position_to_bounds(
        FloatingAssistantPosition { x, y: anchor.y },
        screen,
        launcher_width,
        launcher_height,
        inset,
    )
}

pub fn clamp_position_to_bounds(
    position: FloatingAssistantPosition,
    screen: LogicalScreenBounds,
    window_width: f64,
    window_height: f64,
    inset: f64,
) -> FloatingAssistantPosition {
    let local = clamp_floating_position(
        FloatingAssistantPosition {
            x: position.x - screen.x,
            y: position.y - screen.y,
        },
        screen.width,
        screen.height,
        window_width,
        window_height,
        inset,
    );
    FloatingAssistantPosition {
        x: local.x + screen.x,
        y: local.y + screen.y,
    }
}

fn clamp_axis(position: f64, screen: f64, window: f64, inset: f64) -> f64 {
    let maximum = screen - window - inset;
    if maximum < inset {
        inset
    } else {
        position.clamp(inset, maximum)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_floating_position, default_floating_position, expanded_floating_position,
        fit_window_size_to_bounds, launcher_floating_position, monitor_bounds_containing_position,
        LogicalScreenBounds,
    };
    use crate::settings::FloatingAssistantPosition;

    #[test]
    fn defaults_near_the_right_edge_and_centers_vertically() {
        assert_eq!(
            default_floating_position(1440.0, 900.0, 56.0, 16.0),
            FloatingAssistantPosition {
                x: 1368.0,
                y: 422.0,
            },
        );
    }

    #[test]
    fn clamps_a_saved_position_inside_the_visible_screen() {
        assert_eq!(
            clamp_floating_position(
                FloatingAssistantPosition {
                    x: 1500.0,
                    y: -30.0,
                },
                1440.0,
                900.0,
                56.0,
                56.0,
                16.0,
            ),
            FloatingAssistantPosition { x: 1368.0, y: 16.0 },
        );
    }

    #[test]
    fn clamps_expanded_panel_from_the_pet_anchor() {
        assert_eq!(
            expanded_floating_position(
                FloatingAssistantPosition {
                    x: 1368.0,
                    y: 422.0,
                },
                LogicalScreenBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1440.0,
                    height: 900.0,
                },
                380.0,
                620.0,
                16.0,
            ),
            FloatingAssistantPosition {
                x: 1044.0,
                y: 264.0,
            },
        );
    }

    #[test]
    fn shrinks_an_oversized_panel_to_the_target_screen() {
        assert_eq!(
            fit_window_size_to_bounds(
                1800.0,
                1200.0,
                LogicalScreenBounds {
                    x: 1920.0,
                    y: 0.0,
                    width: 1512.0,
                    height: 982.0,
                },
                16.0,
            ),
            (1480.0, 950.0),
        );
    }

    #[test]
    fn preserves_a_panel_that_already_fits_the_target_screen() {
        assert_eq!(
            fit_window_size_to_bounds(
                380.0,
                620.0,
                LogicalScreenBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1512.0,
                    height: 982.0,
                },
                16.0,
            ),
            (380.0, 620.0),
        );
    }

    #[test]
    fn clamps_launcher_height_and_keeps_right_edge_anchor_alignment() {
        assert_eq!(
            launcher_floating_position(
                FloatingAssistantPosition {
                    x: 1368.0,
                    y: 828.0,
                },
                LogicalScreenBounds {
                    x: 0.0,
                    y: 0.0,
                    width: 1440.0,
                    height: 900.0,
                },
                252.0,
                64.0,
                56.0,
                16.0,
            ),
            FloatingAssistantPosition {
                x: 1368.0 - (252.0 - 56.0),
                y: 820.0,
            },
        );
    }

    #[test]
    fn selects_secondary_bounds_for_negative_anchor_and_rejects_stale_position() {
        let primary = LogicalScreenBounds {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };
        let secondary = LogicalScreenBounds {
            x: -1920.0,
            y: -200.0,
            width: 1920.0,
            height: 1080.0,
        };
        let monitors = [primary, secondary];

        assert_eq!(
            monitor_bounds_containing_position(
                FloatingAssistantPosition {
                    x: -1800.0,
                    y: -100.0,
                },
                &monitors,
            ),
            Some(secondary),
        );
        assert_eq!(
            monitor_bounds_containing_position(
                FloatingAssistantPosition {
                    x: 4000.0,
                    y: 2200.0,
                },
                &monitors,
            ),
            None,
        );
    }
}
