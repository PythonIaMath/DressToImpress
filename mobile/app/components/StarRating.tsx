import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type StarRatingProps = {
  max?: number;
  value?: number;
  disabled?: boolean;
  onChange?: (value: number) => void;
};

const FILLED_STAR = '\u2605';
const OUTLINE_STAR = '\u2606';

export function StarRating({ max = 5, value = 0, disabled, onChange }: StarRatingProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <View style={styles.container}>
      {Array.from({ length: max }, (_, index) => {
        const ratingValue = index + 1;
        const isFilled = hovered !== null ? ratingValue <= hovered : ratingValue <= value;
        return (
          <Pressable
            key={ratingValue}
            disabled={disabled}
            onPress={() => onChange?.(ratingValue)}
            onHoverIn={() => setHovered(ratingValue)}
            onHoverOut={() => setHovered(null)}
            style={styles.starButton}
            accessibilityRole="button"
            accessibilityLabel={`Note ${ratingValue}`}
          >
            <Text style={[styles.star, isFilled ? styles.starFilled : styles.starEmpty]}>
              {isFilled ? FILLED_STAR : OUTLINE_STAR}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 8,
  },
  starButton: {
    padding: 4,
  },
  star: {
    fontSize: 32,
  },
  starFilled: {
    color: '#facc15',
  },
  starEmpty: {
    color: '#cbd5f5',
  },
});
