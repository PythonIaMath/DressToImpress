import { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

type AvatarAnimationControlsProps = {
  options: string[];
  value: string | null;
  onChange: (next: string) => void;
  disabled?: boolean;
};

function formatLabel(name: string) {
  if (!name) {
    return 'Animation';
  }
  return name
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function AvatarAnimationControlsComponent({
  options,
  value,
  onChange,
  disabled,
}: AvatarAnimationControlsProps) {
  if (!options || options.length === 0) {
    return null;
  }
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Animations</Text>
      <View style={styles.row}>
        {options.map((option) => {
          const selected = option === value;
          return (
            <TouchableOpacity
              key={option}
              style={[styles.button, selected && styles.buttonSelected]}
              disabled={disabled}
              onPress={() => onChange(option)}
            >
              <Text style={[styles.buttonLabel, selected && styles.buttonLabelSelected]}>
                {formatLabel(option)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export const AvatarAnimationControls = memo(AvatarAnimationControlsComponent);

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  title: {
    color: '#cbd5f5',
    fontSize: 14,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: 'transparent',
  },
  buttonSelected: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  buttonLabel: {
    color: '#cbd5f5',
    fontSize: 13,
    fontWeight: '500',
  },
  buttonLabelSelected: {
    color: '#f8fafc',
  },
});
